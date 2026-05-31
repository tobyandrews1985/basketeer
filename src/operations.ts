/**
 * Config, constants, and small public helpers. GraphQL query strings are
 * internal and live in queries.ts.
 *
 * The api key is public (baked into Tesco's web JS) and rotates roughly monthly
 * — override via the `TESCO_API_KEY` env var or the client `apiKey` option.
 */

export const PUBLIC_API_KEY = "TvOSZJHlEk0pjniDGQFAc9Q59WGAR4dA";

export const ENDPOINT = "https://xapi.tesco.com/";

/**
 * The Tesco order-summary / payment page. Payment is completed HERE in a browser
 * — a separate CSRF-protected checkout app + 3-D Secure card authentication
 * (browser-bound by design, PCI/fraud-sensitive), deliberately NOT part of the
 * pure-HTTP API. Fill the basket + book a slot via this SDK, then finish here.
 */
export const CHECKOUT_URL =
  "https://www.tesco.com/checkout/en-GB/groceries/order-summary?basketType=GROCERY";

/** Micro-frontend tags Tesco's own client sends per operation. Internal. */
export const MFE = {
  product: "mfe-pdp",
  search: "mfe-plp",
  basket: "mfe-basket",
  slots: "mfe-slots",
  orders: "mfe-orders",
  favourites: "mfe-favourites",
} as const;

/** One context for `orders.list` — an order type plus the statuses to include. */
export interface OrderContext {
  type: string;
  statuses: readonly string[];
}

/** Default contexts for listing upcoming (pending) orders across order types. */
export const PENDING_ORDER_CONTEXTS: readonly OrderContext[] = [
  { type: "GROCERY", statuses: ["Pending"] },
  { type: "MARKETPLACE", statuses: ["Pending"] },
  { type: "FNF", statuses: ["Pending"] },
];

/** Fulfilment method types accepted by the slot ops. */
export const FULFILMENT_TYPE = {
  delivery: "DELIVERY_VAN",
  collection: "COLLECTION_STORE",
} as const;

export type FulfilmentType = (typeof FULFILMENT_TYPE)[keyof typeof FULFILMENT_TYPE];

/**
 * Build a category `facet` for {@link Basketeer.browseCategory} from a
 * department name. Tesco encodes it as `"b;" + base64(name)` — e.g.
 * `categoryFacet("Fresh Food")`. Uses the cross-runtime `btoa` (works in Node,
 * Bun, Deno, browsers, workers). You can also lift a `facet` straight from a
 * Tesco category-page URL (`?...&facet=…`).
 */
export function categoryFacet(department: string): string {
  return "b;" + btoa(department);
}
