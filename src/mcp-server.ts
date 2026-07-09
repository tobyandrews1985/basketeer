#!/usr/bin/env node
/**
 * basketeer MCP server (stdio).
 *
 * Exposes the SDK as Model Context Protocol tools so an MCP agent (Claude
 * Desktop, etc.) can browse the catalogue, fill a basket, and prepare checkout.
 *
 * The client is built with a `FileTokenStore` + `BrowserAuthBackend`:
 *   - Reads (search/product/favourites/slots/orders) work anonymously.
 *   - Authed ops reuse whatever session was saved to
 *     `~/.basketeer/session.json` (mint one with the SDK's login flow).
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
import type { NutritionFilter } from "./index.js";
import { Basketeer, BasketeerError, FileTokenStore } from "./index.js";
import { isMainModule } from "./is-main.js";
import { PRODUCT_FIELDS, projectResults, SEARCH_RESULT_FIELDS } from "./select.js";

/** Wrap a value as MCP JSON text content. */
function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
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

/** Short deterministic token an agent must echo back to confirm a destructive action. */
export function confirmToken(parts: string): string {
  return createHash("sha256").update(parts).digest("hex").slice(0, 8);
}

/**
 * Register every tool against the passed-in client and return the server.
 * Pure: no filesystem/auth/transport side effects — safe to call from a test.
 */
export function buildServer(client: Basketeer): McpServer {
  const server = new McpServer({ name: "basketeer", version: "0.1.1" });

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
    "Set a SKU's basket line to an exact quantity (set-not-increment). quantity 0 removes the line.",
    {
      sku: z.string().describe("The product SKU (tpnc) to set."),
      quantity: z.number().int().nonnegative().describe("Exact quantity to set; 0 removes."),
    },
    { readOnlyHint: false, destructiveHint: true },
    ({ sku, quantity }) => run(() => client.basket.set(sku, quantity)),
  );

  server.tool(
    "basketeer_basket_remove",
    "Remove a SKU from the basket entirely.",
    { sku: z.string().describe("The product SKU (tpnc) to remove.") },
    { readOnlyHint: false, destructiveHint: true },
    ({ sku }) => run(() => client.basket.remove(sku)),
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

// Only build the client (which reads ~/.basketeer/session.json) and attach the
// stdio transport when run as a binary, so the module can be imported (e.g. by a
// smoke test) without any filesystem/auth side effects or starting the server.
if (isMainModule(import.meta.url)) {
  const store = new FileTokenStore();
  const client = new Basketeer({
    session: await store.load(),
    store,
    authBackend: new BrowserAuthBackend(),
  });
  const server = buildServer(client);
  await server.connect(new StdioServerTransport());
}
