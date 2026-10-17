#!/usr/bin/env node
/**
 * basketeer MCP server (stdio).
 *
 * Exposes the SDK as Model Context Protocol tools so an MCP agent (Claude
 * Desktop, etc.) can browse the catalogue, fill a basket, and prepare checkout.
 *
 * The client is built with a `FileTokenStore` + `BrowserAuthBackend`:
 *   - Reads (search/product/favourites/slots/orders) work anonymously.
 *   - Authed ops reuse whatever session was saved for the market
 *     (`~/.basketeer/session.json` for the UK, `session.<code>.json` otherwise;
 *     mint one with `basketeer login`).
 *   - The storefront comes from the `TESCO_MARKET` env var (`uk` default, `cz`).
 *
 * Import safety: building the client (which reads the session file from disk)
 * and connecting the transport happen ONLY when this file is run as the entry
 * point — importing the module has no filesystem/auth side effects.
 *
 * ETHICS CEILING: this server NEVER places or pays for an order. `basketeer_checkout`
 * hands back the payment URL and a note that a human must complete payment in a
 * browser (Tesco's 3-D Secure / CSRF-protected checkout is browser-bound by
 * design). Listing/cancelling orders is fine; paying is not automated.
 *
 * Run: `basketeer-mcp` (stdio). Configure it as an MCP server in your agent.
 */

import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrowserAuthBackend } from "./auth/browser/playwright.js";
import type { Basket, NutritionFilter } from "./index.js";
import { Basketeer, BasketeerError, FileTokenStore } from "./index.js";
import { isMainModule } from "./is-main.js";
import { type Market, resolveMarket } from "./market.js";
import { PRODUCT_FIELDS, projectResults, SEARCH_RESULT_FIELDS } from "./select.js";

/**
 * Wrap a value as MCP JSON text content. `raw` GraphQL escape hatches are
 * omitted at any depth — they duplicate the parsed fields and waste agent
 * context (issue #9).
 */
function json(value: unknown) {
  const text = JSON.stringify(value, (key, v) => (key === "raw" ? undefined : v), 2);
  return { content: [{ type: "text" as const, text }] };
}

/** Run a tool body, mapping SDK errors to a clean MCP error result. */
async function run(fn: () => Promise<unknown>) {
  try {
    return json(await fn());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const kind = err instanceof BasketeerError ? err.name : "Error";
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify({ error: kind, message }, null, 2) }],
    };
  }
}

/** Zod param for `select` — the dot-notation projection on search results (issue #10). */
function selectParam(fields: readonly string[]) {
  return z
    .array(z.string())
    .nonempty()
    .optional()
    .describe(
      "Optional list of dot-notation paths to keep in each result (token saver), " +
        'e.g. ["sku", "title", "price.actual", "promotions.description"]. ' +
        `Top-level fields: ${fields.join(", ")}. Omit for full results.`,
    );
}

/**
 * Compact mutation receipt (issue #9): basket writes confirm rather than
 * re-enumerate, so per-call output stays flat as the basket grows. Full state
 * stays one `basketeer_basket_get` call away.
 */
function receipt(basket: Basket, sku: string) {
  return {
    sku,
    quantity: basket.items.find((i) => i.sku === sku)?.quantity ?? 0,
    itemCount: basket.items.length,
    guidePrice: basket.guidePrice,
    isInAmend: basket.isInAmend,
  };
}

/** Short deterministic token an agent must echo back to confirm a destructive action. */
export function confirmToken(parts: string): string {
  return createHash("sha256").update(parts).digest("hex").slice(0, 8);
}

/**
 * Register every tool against the passed-in client and return the server.
 * Pure: no filesystem/auth/transport side effects — safe to call from a test.
 */
export function buildServer(client: Basketeer): McpServer {
  const { market } = client;
  const server = new McpServer(
    { name: "basketeer", version: "0.1.1" },
    {
      instructions:
        `Connected to the Tesco ${market.code.toUpperCase()} storefront (${market.shopOrigin}). ` +
        `Prices are in ${market.currency}; search in the storefront's language (${market.language}).`,
    },
  );

  // --- reads (anonymous OK) -------------------------------------------------

  server.tool(
    "basketeer_search",
    "Search the Tesco grocery catalogue. Returns matching products with SKU, title, price, offers, and quantityRules (weight/bulk buy limits).",
    {
      query: z.string().describe("Search terms, e.g. 'semi skimmed milk'."),
      limit: z.number().int().positive().optional(),
      select: selectParam(SEARCH_RESULT_FIELDS),
    },
    { readOnlyHint: true },
    ({ query, limit, select }) =>
      run(async () => {
        const page = await client.search(query, { limit });
        return select
          ? { ...page, results: projectResults(page.results, select, SEARCH_RESULT_FIELDS) }
          : page;
      }),
  );

  server.tool(
    "basketeer_product",
    "Fetch one product by SKU (tpnc), including price, pack size, promotions, quantityRules (weight/bulk buy/catch weight options), and nutrition.",
    { sku: z.string().describe("The product SKU (tpnc), e.g. from a search result.") },
    { readOnlyHint: true },
    ({ sku }) => run(() => client.getProduct(sku)),
  );

  server.tool(
    "basketeer_favourites",
    "List the signed-in customer's favourites ('my usuals') including price, offers, and quantityRules. Requires a saved session.",
    { limit: z.number().int().positive().optional() },
    { readOnlyHint: true },
    ({ limit }) => run(() => client.favourites({ limit })),
  );

  server.tool(
    "basketeer_nutrition",
    "Normalized nutrition (typed macros + micros) for a product by SKU.",
    { sku: z.string().describe("The product SKU (tpnc).") },
    { readOnlyHint: true },
    ({ sku }) => run(() => client.getProduct(sku).then((p) => p.nutrition)),
  );

  server.tool(
    "basketeer_search_by_nutrition",
    "Search products by keyword, then filter/rank by nutrition (per 100g/ml). " +
      "Hydrates each candidate with a throttled product fetch; bounded by `hydrate`.",
    {
      query: z.string().describe("Search terms, e.g. 'greek yogurt'."),
      minProtein: z.number().optional().describe("Minimum protein (g per 100g/ml)."),
      maxSugar: z.number().optional().describe("Maximum sugars (g per 100g/ml)."),
      sortBy: z.string().optional().describe("Macro to sort by descending, e.g. 'protein'."),
      hydrate: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max candidates to fetch nutrition for (default 20)."),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max results to return after filtering."),
      select: selectParam(PRODUCT_FIELDS),
    },
    { readOnlyHint: true },
    ({ query, minProtein, maxSugar, sortBy, hydrate, limit, select }) =>
      run(async () => {
        const where: NutritionFilter = {};
        if (minProtein != null) where.protein = { min: minProtein };
        if (maxSugar != null) where.sugars = { max: maxSugar };
        const sort = sortBy ? { by: sortBy, dir: "desc" as const } : undefined;
        const page = await client.searchByNutrition(query, { where, sort, hydrate, limit });
        return select
          ? { ...page, results: projectResults(page.results, select, PRODUCT_FIELDS) }
          : page;
      }),
  );

  // --- basket (requires a saved session) ------------------------------------

  server.tool(
    "basketeer_basket_get",
    "Get the current basket: line items, quantities, and guide price.",
    {},
    { readOnlyHint: true },
    () => run(() => client.basket.get()),
  );

  server.tool(
    "basketeer_basket_set",
    "Set a SKU's basket line to an exact quantity (set-not-increment). quantity 0 removes the line. " +
      "Returns a compact receipt; call basketeer_basket_get for full basket contents.",
    {
      sku: z.string().describe("The product SKU (tpnc) to set."),
      quantity: z.number().int().nonnegative().describe("Exact quantity to set; 0 removes."),
    },
    { readOnlyHint: false, destructiveHint: true },
    ({ sku, quantity }) => run(async () => receipt(await client.basket.set(sku, quantity), sku)),
  );

  server.tool(
    "basketeer_basket_remove",
    "Remove a SKU from the basket entirely. " +
      "Returns a compact receipt; call basketeer_basket_get for full basket contents.",
    { sku: z.string().describe("The product SKU (tpnc) to remove.") },
    { readOnlyHint: false, destructiveHint: true },
    ({ sku }) => run(async () => receipt(await client.basket.remove(sku), sku)),
  );

  // --- slots (requires a saved session) -------------------------------------

  server.tool(
    "basketeer_slots_list",
    "List delivery slots over a date window (defaults to today..+6 days). Dates are YYYY-MM-DD.",
    {
      start: z.string().optional().describe("Window start, YYYY-MM-DD."),
      end: z.string().optional().describe("Window end, YYYY-MM-DD."),
    },
    { readOnlyHint: true },
    ({ start, end }) => run(() => client.slots.list({ start, end })),
  );

  server.tool(
    "basketeer_slots_book",
    "Reserve a delivery slot by ID from basketeer_slots_list. Replaces any slot already reserved " +
      "for the basket. The hold lapses at reservationExpiry unless the order is checked out. " +
      "Does not place or pay for an order.",
    {
      slotId: z.string().min(1).describe("The delivery slot ID returned by basketeer_slots_list."),
    },
    { readOnlyHint: false, destructiveHint: true },
    ({ slotId }) => run(() => client.slots.book(slotId)),
  );

  server.tool(
    "basketeer_slots_release",
    "Release a reserved delivery slot by ID (the slot with status 'Booked' in basketeer_slots_list). " +
      "Once released, the slot may be taken by another customer.",
    { slotId: z.string().min(1).describe("The reserved delivery slot ID to release.") },
    { readOnlyHint: false, destructiveHint: true },
    ({ slotId }) => run(() => client.slots.release(slotId)),
  );

  // --- orders (requires a saved session) ------------------------------------

  server.tool(
    "basketeer_orders_list",
    "List upcoming (pending) orders with their items, slot, and amend window.",
    {},
    { readOnlyHint: true },
    () => run(() => client.orders.list()),
  );

  server.tool(
    "basketeer_orders_cancel",
    "Cancel an upcoming order outright (only before its amend/cancel cutoff). " +
      "Two-step: call once with just orderNo to get a confirmToken and a preview; " +
      "call again with confirm set to that token to actually cancel. Cancelling is irreversible.",
    { orderNo: z.string().describe("The order number to cancel."), confirm: z.string().optional() },
    { readOnlyHint: false, destructiveHint: true },
    ({ orderNo, confirm }) =>
      run(async () => {
        const token = confirmToken(`cancel:${orderNo}`);
        if (confirm !== token) {
          return {
            requiresConfirmation: true,
            action: "cancel_order",
            orderNo,
            confirmToken: token,
            hint: "Cancelling is irreversible. Call again with confirm set to this confirmToken to proceed.",
          };
        }
        await client.orders.cancel(orderNo);
        return { ok: true, cancelled: orderNo };
      }),
  );

  server.tool(
    "basketeer_orders_amend",
    "Open an upcoming order for changes (only before its amendExpiry). While it is open, " +
      "basketeer_basket_set / basketeer_basket_remove edit THAT order instead of a new basket. " +
      "Changes are only saved once the human completes basketeer_checkout's URL (paying any difference); " +
      "otherwise call basketeer_orders_amend_discard. Returns the order's working basket.",
    { orderNo: z.string().min(1).describe("The order number from basketeer_orders_list.") },
    { readOnlyHint: false, destructiveHint: false },
    ({ orderNo }) =>
      run(async () => {
        const amendment = await client.orders.amend(orderNo);
        return { amending: orderNo, basket: await amendment.get() };
      }),
  );

  server.tool(
    "basketeer_orders_amend_discard",
    "Abandon an order opened with basketeer_orders_amend, dropping unsaved changes and leaving the order as it was. " +
      "Two-step: call once with just orderNo to get a confirmToken; call again with confirm set to that token.",
    {
      orderNo: z.string().min(1).describe("The order number currently open for amendment."),
      confirm: z.string().optional(),
    },
    { readOnlyHint: false, destructiveHint: true },
    ({ orderNo, confirm }) =>
      run(async () => {
        const token = confirmToken(`discard-amend:${orderNo}`);
        if (confirm !== token) {
          return {
            requiresConfirmation: true,
            action: "discard_amendment",
            orderNo,
            confirmToken: token,
            hint: "Discarding drops every unsaved change to this order. Call again with confirm set to this confirmToken to proceed.",
          };
        }
        await client.orders.discardAmend(orderNo);
        return { ok: true, discarded: orderNo };
      }),
  );

  server.tool(
    "basketeer_last_order",
    "Return the last delivered (fulfilled) order and its items, e.g. for 'reorder my usual shop'. " +
      "Returns null if there is none. This is a read — to reorder, add its items via basketeer_basket_set.",
    {},
    { readOnlyHint: true },
    () => run(() => client.orders.lastFulfilled()),
  );

  // --- checkout (boundary: stops at the payment URL) ------------------------

  server.tool(
    "basketeer_checkout",
    "Prepare checkout: returns the current basket and the URL where a HUMAN completes payment in a browser. " +
      "This server never places or pays for an order — Tesco's 3-D Secure payment step is browser-bound by design. " +
      "Two-step: call once with no args to preview the basket and get a confirmToken; " +
      "call again with confirm set to that token to get the payment URL for the human to complete.",
    { confirm: z.string().optional() },
    { readOnlyHint: false, destructiveHint: true },
    ({ confirm }) =>
      run(async () => {
        const basket = await client.basket.get();
        const signature = `${basket.items.length}:${basket.guidePrice ?? ""}`;
        const token = confirmToken(`checkout:${signature}`);
        if (confirm !== token) {
          return {
            requiresConfirmation: true,
            action: "checkout",
            basket,
            confirmToken: token,
            hint: "Checkout returns the current basket and a payment URL for a human to complete in a browser. Call again with confirm set to this confirmToken to proceed.",
          };
        }
        const { basket: cart, url } = await client.checkout();
        return {
          basket: cart,
          paymentUrl: url,
          note: "Payment is NOT automated. Open paymentUrl in a browser and complete payment (card + 3-D Secure) yourself.",
        };
      }),
  );

  return server;
}

// --- start ------------------------------------------------------------------

// Only build the client (which reads the market's session file) and attach the
// stdio transport when run as a binary, so the module can be imported (e.g. by a
// smoke test) without any filesystem/auth side effects or starting the server.
if (isMainModule(import.meta.url)) {
  let market: Market;
  try {
    market = resolveMarket(process.env.TESCO_MARKET);
  } catch (err) {
    process.stderr.write(`basketeer-mcp: TESCO_MARKET: ${(err as Error).message}\n`);
    process.exit(1);
  }
  const store = new FileTokenStore({ market });
  const client = new Basketeer({
    market,
    session: await store.load(),
    store,
    authBackend: new BrowserAuthBackend({ market }),
  });
  const server = buildServer(client);
  await server.connect(new StdioServerTransport());
}
