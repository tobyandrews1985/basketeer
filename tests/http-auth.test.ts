import { describe, expect, it } from "vitest";
import { HttpAuthBackend } from "../src/auth/http.js";
import { AuthExpiredError, RateLimitedError } from "../src/errors.js";
import { MARKETS, refreshUrl } from "../src/market.js";
import type { Session } from "../src/models.js";

const SESSION: Session = {
  accessToken: "old.token.sig",
  customerUuid: "uuid-1",
  cookies: {
    "OAuth.AccessToken": "old.token.sig",
    "OAuth.RefreshToken": "refresh-1",
    UUID: "uuid-1",
    _abck: "akamai-1",
  },
  market: "cz",
};

function stub(status: number, setCookies: string[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const headers = new Headers();
    for (const c of setCookies) headers.append("set-cookie", c);
    return new Response(null, { status, headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("HttpAuthBackend", () => {
  it("replays the session cookies to the market's refresh endpoint and harvests the rotation", async () => {
    const { impl, calls } = stub(302, [
      "OAuth.AccessToken=new.token.sig; Domain=.itesco.cz; Path=/; Secure; HttpOnly",
      "OAuth.RefreshToken=refresh-2; Domain=.itesco.cz; Path=/; Expires=Mon, 16 Nov 2026 20:08:00 GMT",
      "atrc=ignored; Path=/",
    ]);
    const backend = new HttpAuthBackend({ market: "cz", fetchImpl: impl });
    const renewed = await backend.refresh(SESSION);

    expect(calls[0]!.url).toBe(refreshUrl(MARKETS.cz));
    expect(calls[0]!.init.redirect).toBe("manual");
    const sent = (calls[0]!.init.headers as Record<string, string>).cookie;
    expect(sent).toContain("OAuth.RefreshToken=refresh-1");
    expect(sent).toContain("_abck=akamai-1");

    expect(renewed).toMatchObject({
      accessToken: "new.token.sig",
      customerUuid: "uuid-1",
      market: "cz",
    });
    expect(renewed.cookies).toEqual({
      "OAuth.AccessToken": "new.token.sig",
      "OAuth.RefreshToken": "refresh-2",
      UUID: "uuid-1",
      _abck: "akamai-1",
    });
  });

  it("asks for a re-login when no new access token comes back", async () => {
    const { impl } = stub(302, ["atrc=x; Path=/"]);
    await expect(
      new HttpAuthBackend({ market: "cz", fetchImpl: impl }).refresh(SESSION),
    ).rejects.toThrow(AuthExpiredError);
  });

  it("surfaces an Akamai block as RateLimitedError", async () => {
    const { impl } = stub(403, []);
    await expect(
      new HttpAuthBackend({ market: "cz", fetchImpl: impl }).refresh(SESSION),
    ).rejects.toThrow(RateLimitedError);
  });

  it("cannot sign in", async () => {
    await expect(new HttpAuthBackend().login()).rejects.toThrow(AuthExpiredError);
  });
});
