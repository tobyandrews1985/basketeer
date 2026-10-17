/**
 * Tesco storefronts ("markets") that share the `xapi.tesco.com` gateway.
 *
 * Every market speaks the same GraphQL schema with the same public api key;
 * what differs is the `region`/`language` header pair the gateway routes on,
 * the web origins (Czech Tesco serves the shop and the account/checkout apps
 * from different hosts), the cookie domain the session lives on, and the local
 * time zone delivery slots are expressed in.
 */

export interface Market {
  /** Short, lower-case identifier: `"uk"`, `"cz"`. */
  readonly code: string;
  /** Value of the gateway's `region` header. */
  readonly region: string;
  /** BCP 47 tag used for the `language` header and in web paths, e.g. `"en-GB"`. */
  readonly language: string;
  /** Origin of the groceries shop (product pages, landing). */
  readonly shopOrigin: string;
  /** Origin of the account (login, token refresh) and checkout apps. */
  readonly accountOrigin: string;
  /** Registrable domain the auth + Akamai cookies are set on. */
  readonly cookieDomain: string;
  /** IANA time zone of the storefront; delivery-slot dates are local to it. */
  readonly timeZone: string;
  /** ISO 4217 code all prices are in. */
  readonly currency: string;
}

export const MARKETS = {
  uk: {
    code: "uk",
    region: "UK",
    language: "en-GB",
    shopOrigin: "https://www.tesco.com",
    accountOrigin: "https://www.tesco.com",
    cookieDomain: "tesco.com",
    timeZone: "Europe/London",
    currency: "GBP",
  },
  cz: {
    code: "cz",
    region: "CZ",
    language: "cs-CZ",
    shopOrigin: "https://nakup.itesco.cz",
    accountOrigin: "https://www.itesco.cz",
    cookieDomain: "itesco.cz",
    timeZone: "Europe/Prague",
    currency: "CZK",
  },
} as const satisfies Record<string, Market>;

export type MarketCode = keyof typeof MARKETS;

export const DEFAULT_MARKET: Market = MARKETS.uk;

/** True when `code` names a built-in market. */
export function isMarketCode(code: string): code is MarketCode {
  return Object.hasOwn(MARKETS, code);
}

/**
 * Resolve a market from its code (case-insensitive) or pass a custom
 * {@link Market} through unchanged. Undefined yields {@link DEFAULT_MARKET}.
 *
 * @throws {RangeError} for an unknown market code.
 */
export function resolveMarket(market?: string | Market): Market {
  if (market === undefined) return DEFAULT_MARKET;
  if (typeof market !== "string") return market;
  const code = market.trim().toLowerCase();
  if (!isMarketCode(code)) {
    throw new RangeError(
      `Unknown Tesco market "${market}". Known markets: ${Object.keys(MARKETS).join(", ")}.`,
    );
  }
  return MARKETS[code];
}

/** Groceries landing page; the post-login and post-refresh destination. */
export function groceriesUrl(market: Market): string {
  return `${market.shopOrigin}/shop/${market.language}/landing/groceries`;
}

/** Interactive sign-in page. */
export function loginUrl(market: Market): string {
  return `${market.accountOrigin}/account/login/${market.language}`;
}

/**
 * Token rotation endpoint. `soft-refresh=false` forces a rotation even while
 * the current token is still valid, so a refresh deterministically yields a
 * fresh ~1h token; the endpoint then redirects to the groceries landing.
 */
export function refreshUrl(market: Market): string {
  const from = encodeURIComponent(groceriesUrl(market));
  return `${market.accountOrigin}/account/auth/${market.language}/refresh-token?soft-refresh=false&from=${from}`;
}

/**
 * The order-summary / payment page. Payment is completed HERE in a browser —
 * a separate CSRF-protected checkout app + 3-D Secure card authentication
 * (browser-bound by design), deliberately NOT part of the pure-HTTP API.
 */
export function checkoutUrl(market: Market): string {
  return `${market.accountOrigin}/checkout/${market.language}/groceries/order-summary?basketType=GROCERY`;
}

/** True when a cookie set on `domain` belongs to the market's cookie domain. */
export function isMarketCookieDomain(market: Market, domain: string): boolean {
  const host = domain.replace(/^\./, "").toLowerCase();
  return host === market.cookieDomain || host.endsWith(`.${market.cookieDomain}`);
}
