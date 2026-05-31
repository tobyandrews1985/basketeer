#!/usr/bin/env node
/**
 * basketeer MCP server (stdio).
 *
 * Exposes the SDK as Model Context Protocol tools so an MCP agent (Claude
 * Desktop, etc.) can browse the catalogue, fill a basket, and prepare checkout.
 *
 * The client is built with `Basketeer.resume({ store: new FileTokenStore() })`:
 *   - Reads (search/product/favourites/slots/orders) work anonymously.
 *   - Authed ops reuse whatever session was saved to
 *     `~/.basketeer/session.json` (mint one with the SDK's login flow).
 *
 * ETHICS CEILING: this server NEVER places or pays for an order. `basketeer_checkout`
 * hands back the payment URL and a note that a human must complete payment in a
 * browser (Tesco's 3-D Secure / CSRF-protected checkout is browser-bound by
 * design). Listing/cancelling orders is fine; paying is not automated.
 *
 * Run: `basketeer-mcp` (stdio). Configure it as an MCP server in your agent.
 */

import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrowserAuthBackend } from "./auth/browser/playwright.js";
import type { NutritionFilter } from "./index.js";
import { Basketeer, BasketeerError, FileTokenStore } from "./index.js";

// One shared client for the process. Load any persisted session from disk, then
// construct with BrowserAuthBackend so authed tools can refresh past the ~1h
// token lifetime via the lazy on-401 path (no proactive browser launch at startup).
const _store = new FileTokenStore();
const client = new Basketeer({
  session: await _store.load(),
  store: _store,
  authBackend: new BrowserAuthBackend(),
});

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

const server = new McpServer({ name: "basketeer", version: "0.1.0" });

// --- reads (anonymous OK) ---------------------------------------------------

server.tool(
  "basketeer_search",
  "Search the Tesco grocery catalogue. Returns matching products with SKU, title, price, and any offers.",
  {
    query: z.string().describe("Search terms, e.g. 'semi skimmed milk'."),
    limit: z.number().int().positive().optional(),
  },
  { readOnlyHint: true },
  ({ query, limit }) => run(() => client.search(query, { limit })),
);

server.tool(
  "basketeer_product",
  "Fetch one product by SKU (tpnc), including price, pack size, promotions, and nutrition.",
  { sku: z.string().describe("The product SKU (tpnc), e.g. from a search result.") },
  { readOnlyHint: true },
  ({ sku }) => run(() => client.getProduct(sku)),
);

server.tool(
  "basketeer_favourites",
  "List the signed-in customer's favourites ('my usuals'). Requires a saved session.",
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
  },
  { readOnlyHint: true },
  ({ query, minProtein, maxSugar, sortBy, hydrate, limit }) =>
    run(() => {
      const where: NutritionFilter = {};
      if (minProtein != null) where.protein = { min: minProtein };
      if (maxSugar != null) where.sugars = { max: maxSugar };
      const sort = sortBy ? { by: sortBy, dir: "desc" as const } : undefined;
      return client.searchByNutrition(query, { where, sort, hydrate, limit });
    }),
);

// --- basket (requires a saved session) --------------------------------------

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

// --- slots (requires a saved session) ---------------------------------------

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

// --- orders (requires a saved session) --------------------------------------

server.tool(
  "basketeer_orders_list",
  "List upcoming (pending) orders with their items, slot, and amend window.",
  {},
  { readOnlyHint: true },
  () => run(() => client.orders.list()),
);

server.tool(
  "basketeer_orders_cancel",
  "Cancel an upcoming order outright (only before its amend/cancel cutoff).",
  { orderNo: z.string().describe("The order number to cancel.") },
  { readOnlyHint: false, destructiveHint: true },
  ({ orderNo }) => run(() => client.orders.cancel(orderNo).then(() => ({ cancelled: orderNo }))),
);

server.tool(
  "basketeer_reorder_last",
  "Get the last delivered order and its items, for 'reorder my usual shop'. Returns null if none.",
  {},
  { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  () => run(() => client.orders.lastFulfilled()),
);

// --- checkout (boundary: stops at the payment URL) --------------------------

server.tool(
  "basketeer_checkout",
  "Prepare checkout: returns the current basket and the URL where a HUMAN completes payment in a browser. " +
    "This server never places or pays for an order — Tesco's 3-D Secure payment step is browser-bound by design.",
  {},
  { readOnlyHint: false, destructiveHint: true },
  () =>
    run(async () => {
      const { basket, url } = await client.checkout();
      return {
        basket,
        paymentUrl: url,
        note: "Payment is NOT automated. Open paymentUrl in a browser and complete payment (card + 3-D Secure) yourself.",
      };
    }),
);

// --- start ------------------------------------------------------------------

// Only attach the stdio transport when run as a binary, so the module can be
// imported (e.g. by a smoke test) without starting/blocking the server.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await server.connect(new StdioServerTransport());
}
