import { readFileSync } from "node:fs";

/**
 * Tesco storefronts ("markets") that share the `xapi.tesco.com` gateway.
 *
 * Every market speaks the same GraphQL schema with the same public api key;
 * what differs is the `region`/`language` header pair the gateway routes on,
 * the web origins (Czech Tesco serves the shop and the account/checkout apps
 * from different hosts), the cookie domain the session lives on, and the local
 * time zone delivery slots are expressed in.
 */

/**
 * How a built-in market is looked after: `official` by the project,
 * `community` by a named contributor and labelled experimental. A custom
 * {@link Market} has no support level: it is untested and unsupported.
 */
export type MarketSupport = "official" | "community";

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
  /** Set on built-in markets only. */
  readonly support?: MarketSupport;
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
    support: "official",
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
    support: "community",
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

const MARKET_CONFIG_FIELDS = [
  "code",
  "region",
  "language",
  "shopOrigin",
  "accountOrigin",
  "cookieDomain",
  "timeZone",
  "currency",
] as const satisfies readonly (keyof Market)[];

function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    // Intl also takes offsets such as "+01:00"; slot dates need a named zone.
    return /^[A-Za-z]/.test(value);
  } catch {
    return false;
  }
}

function isCanonicalLocale(value: string): boolean {
  try {
    return Intl.getCanonicalLocales(value)[0] === value;
  } catch {
    return false;
  }
}

function originOnDomain(origin: string, domain: string): boolean {
  const host = new URL(origin).hostname;
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Validate an untyped value as a custom {@link Market}. All fields are required
 * and unknown ones rejected, so a typo cannot silently fall back to anything.
 *
 * @throws {RangeError} naming the first problem found.
 */
export function parseMarketConfig(value: unknown): Market {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RangeError("Market config must be a JSON object.");
  }
  const raw = value as Record<string, unknown>;
  const known: readonly string[] = MARKET_CONFIG_FIELDS;
  const unknownField = Object.keys(raw).find((key) => !known.includes(key));
  if (unknownField) throw new RangeError(`Market config has an unknown field "${unknownField}".`);
  for (const field of MARKET_CONFIG_FIELDS) {
    if (typeof raw[field] !== "string" || raw[field] === "") {
      throw new RangeError(`Market config needs a non-empty string "${field}".`);
    }
  }
  const market = raw as unknown as Market;
  // The code names the session file, so it must stay a plain file-name segment.
  if (!/^[a-z][a-z0-9-]*$/.test(market.code)) {
    throw new RangeError(`Market config "code" must be lower-case letters, digits or dashes.`);
  }
  if (isMarketCode(market.code)) {
    throw new RangeError(`Market config "code" must not reuse the built-in "${market.code}".`);
  }
  // Region and language become request headers; language also reaches the MCP instructions.
  if (!/^[A-Z]{2}$/.test(market.region)) {
    throw new RangeError(`Market config "region" must be two upper-case letters such as "IE".`);
  }
  if (!isCanonicalLocale(market.language)) {
    throw new RangeError(`Market config "language" must be a BCP 47 tag such as "en-IE".`);
  }
  // A bare suffix such as "com" would claim the cookies of every storefront under it.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(market.cookieDomain)) {
    throw new RangeError(`Market config "cookieDomain" must be a domain such as "tesco.ie".`);
  }
  for (const field of ["shopOrigin", "accountOrigin"] as const) {
    if (!isHttpsOrigin(market[field])) {
      throw new RangeError(`Market config "${field}" must be an https origin, with no path.`);
    }
    if (!originOnDomain(market[field], market.cookieDomain)) {
      throw new RangeError(`Market config "${field}" must be on "cookieDomain".`);
    }
  }
  if (!isTimeZone(market.timeZone)) {
    throw new RangeError(`Market config "timeZone" is not a known IANA time zone.`);
  }
  if (!/^[A-Z]{3}$/.test(market.currency)) {
    throw new RangeError(`Market config "currency" must be an ISO 4217 code such as "EUR".`);
  }
  return market;
}

/**
 * Read a custom {@link Market} from a JSON file.
 *
 * @throws {RangeError} when the file cannot be read or is not a valid market.
 */
export function loadMarketConfig(path: string): Market {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new RangeError(`Cannot read market config ${path}: ${(err as Error).message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new RangeError(`Market config ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parseMarketConfig(value);
}

/**
 * The market selected by `TESCO_MARKET` or `TESCO_MARKET_CONFIG`.
 *
 * @throws {RangeError} when both are set, or for an invalid value.
 */
export function marketFromEnv(env: Record<string, string | undefined> = process.env): Market {
  const { TESCO_MARKET: code, TESCO_MARKET_CONFIG: configPath } = env;
  if (configPath === undefined) return resolveMarket(code);
  if (code !== undefined) {
    throw new RangeError("Set either TESCO_MARKET or TESCO_MARKET_CONFIG, not both.");
  }
  return loadMarketConfig(configPath);
}

/** A one-line caveat about the market's support level; empty for official markets. */
export function marketSupportNotice(market: Market): string {
  // Only the built-in object counts: a spread such as `{ ...MARKETS.cz, code: "sk" }` is custom.
  const builtIn = isMarketCode(market.code) && MARKETS[market.code] === market;
  if (builtIn && market.support === "official") return "";
  if (builtIn && market.support === "community") {
    return `The ${market.code.toUpperCase()} storefront is experimental and community-maintained.`;
  }
  return `"${market.code}" is a custom market: untested and unsupported, with no guarantees.`;
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
