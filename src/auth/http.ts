import { AuthExpiredError, RateLimitedError } from "../errors.js";
import { type Market, type MarketCode, refreshUrl, resolveMarket } from "../market.js";
import type { Session } from "../models.js";
import { sessionFromCookies } from "./harvest.js";
import type { AuthBackend } from "./types.js";

const DEFAULT_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

export interface HttpAuthOptions {
  /** Storefront whose tokens are renewed: a market code or a custom {@link Market}. Default UK. */
  market?: MarketCode | Market;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

/**
 * Browserless renewal: replays the session's cookies against the market's
 * refresh endpoint and harvests the rotated `OAuth.*` cookies from its
 * `Set-Cookie` headers.
 *
 * Whether Akamai lets a plain HTTP client through is storefront-specific: it
 * works for Tesco Czech Republic from a residential connection, while the UK
 * storefront rejects it (use `BrowserAuthBackend` there). Sign-in itself
 * always needs a real browser, so `login()` is unsupported — mint the session
 * with `BrowserAuthBackend` or `sessionFromCookies`, then let this backend keep
 * it alive for the refresh token's lifetime (~30 days).
 */
export class HttpAuthBackend implements AuthBackend {
  readonly market: Market;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(opts: HttpAuthOptions = {}) {
    this.market = resolveMarket(opts.market);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.userAgent = opts.userAgent ?? DEFAULT_UA;
  }

  async login(): Promise<Session> {
    throw new AuthExpiredError(
      "HttpAuthBackend cannot sign in: Tesco sign-in needs a real browser. Mint a session with " +
        "BrowserAuthBackend or sessionFromCookies(...); this backend then renews it.",
    );
  }

  async refresh(session: Session): Promise<Session> {
    const res = await this.fetchImpl(refreshUrl(this.market), {
      redirect: "manual",
      headers: {
        cookie: Object.entries(session.cookies)
          .map(([k, v]) => `${k}=${v}`)
          .join("; "),
        "user-agent": this.userAgent,
        accept: "text/html",
        "accept-language": this.market.language,
      },
    });
    if (res.status === 403 || res.status === 429) {
      throw new RateLimitedError(
        res.status,
        `Tesco refused the HTTP token refresh (${res.status}); this storefront may need BrowserAuthBackend.`,
      );
    }

    const rotated = parseSetCookies(res.headers);
    if (!rotated.has("OAuth.AccessToken")) {
      throw new AuthExpiredError(
        `Tesco token refresh returned no new access token (HTTP ${res.status}) — interactive re-login required.`,
      );
    }
    const cookies = { ...session.cookies, ...Object.fromEntries(rotated) };
    return sessionFromCookies(
      Object.entries(cookies).map(([name, value]) => ({ name, value })),
      { market: this.market },
    );
  }
}

/** Name → value of every cookie a response sets (attributes dropped). */
function parseSetCookies(headers: Headers): Map<string, string> {
  if (typeof headers.getSetCookie !== "function") {
    throw new Error("HttpAuthBackend needs Headers.getSetCookie (Node.js 19.7 or newer).");
  }
  const out = new Map<string, string>();
  for (const line of headers.getSetCookie()) {
    const pair = line.split(";", 1)[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq > 0) out.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return out;
}
