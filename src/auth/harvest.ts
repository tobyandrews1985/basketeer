import { AuthExpiredError } from "../errors.js";
import { jwtExpiryMs } from "../jwt.js";
import type { Session } from "../models.js";

/** Tesco-domain cookies worth replaying on authenticated calls (auth + Akamai). */
const COOKIE_PREFIXES = ["OAuth.", "UUID", "bm_", "_abck"] as const;
const COOKIE_NAMES = new Set(["_pxhd", "ak_bmsc"]);

export function keepCookie(name: string): boolean {
  return COOKIE_NAMES.has(name) || COOKIE_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Build a {@link Session} from a browser's cookie list — Playwright's
 * `context.cookies()`, Puppeteer's `page.cookies()`, or any `{name, value}[]`
 * you harvested yourself. Keeps only the Tesco auth + Akamai cookies needed to
 * replay authenticated calls. Use this when writing your own `AuthBackend`
 * (local Chrome, a hosted browser, your own browser farm, …) — the rest of the
 * library doesn't care how the session was minted.
 *
 * @throws {AuthExpiredError} if the OAuth.AccessToken / UUID cookies are absent
 *   (sign-in incomplete or session expired).
 */
export function sessionFromCookies(
  cookies: ReadonlyArray<{ name: string; value: string }>,
): Session {
  const jar: Record<string, string> = {};
  for (const c of cookies) if (keepCookie(c.name)) jar[c.name] = c.value;

  const accessToken = jar["OAuth.AccessToken"];
  const customerUuid = jar["UUID"];
  if (!accessToken || !customerUuid) {
    throw new AuthExpiredError(
      "No OAuth.AccessToken + UUID cookies in the harvested set — sign-in incomplete or expired.",
    );
  }
  return { accessToken, customerUuid, cookies: jar, accessTokenExpiry: jwtExpiryMs(accessToken) };
}
