import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionFromCookies } from "../src/auth/harvest.js";
import type { AuthBackend } from "../src/auth/types.js";
import { Basketeer } from "../src/client.js";
import { MarketMismatchError } from "../src/errors.js";
import {
  checkoutUrl,
  DEFAULT_MARKET,
  groceriesUrl,
  isMarketCookieDomain,
  loginUrl,
  MARKETS,
  type Market,
  refreshUrl,
  resolveMarket,
} from "../src/market.js";
import { CHECKOUT_URL } from "../src/operations.js";
import { isoDate } from "../src/parsers.js";
import { SessionManager } from "../src/session-manager.js";
import { defaultSessionPath, FileTokenStore } from "../src/store/file-store.js";
import { MemoryTokenStore } from "../src/store/memory-store.js";
import { SESSION, stubFetch } from "./helpers.js";

const EMPTY_BASKET = [{ data: { basket: { id: null, guidePrice: 0, items: [] } } }];

describe("resolveMarket", () => {
  it("defaults to the UK", () => {
    expect(resolveMarket()).toBe(MARKETS.uk);
    expect(DEFAULT_MARKET).toBe(MARKETS.uk);
  });

  it("resolves codes case-insensitively", () => {
    expect(resolveMarket("cz")).toBe(MARKETS.cz);
    expect(resolveMarket(" CZ ")).toBe(MARKETS.cz);
  });

  it("passes a custom market through", () => {
    const custom: Market = { ...MARKETS.cz, code: "sk", region: "SK", language: "sk-SK" };
    expect(resolveMarket(custom)).toBe(custom);
  });

  it("rejects unknown codes, naming the known ones", () => {
    expect(() => resolveMarket("de")).toThrow(RangeError);
    expect(() => resolveMarket("de")).toThrow(/uk, cz/);
  });
});

describe("market URLs", () => {
  it("reproduces the UK URLs used before markets existed", () => {
    expect(checkoutUrl(MARKETS.uk)).toBe(
      "https://www.tesco.com/checkout/en-GB/groceries/order-summary?basketType=GROCERY",
    );
    expect(CHECKOUT_URL).toBe(checkoutUrl(MARKETS.uk));
    expect(refreshUrl(MARKETS.uk)).toBe(
      "https://www.tesco.com/account/auth/en-GB/refresh-token?soft-refresh=false" +
        "&from=https%3A%2F%2Fwww.tesco.com%2Fshop%2Fen-GB%2Flanding%2Fgroceries",
    );
  });

  it("splits shop and account hosts for Czech Tesco", () => {
    expect(groceriesUrl(MARKETS.cz)).toBe("https://nakup.itesco.cz/shop/cs-CZ/landing/groceries");
    expect(loginUrl(MARKETS.cz)).toBe("https://www.itesco.cz/account/login/cs-CZ");
    expect(checkoutUrl(MARKETS.cz)).toBe(
      "https://www.itesco.cz/checkout/cs-CZ/groceries/order-summary?basketType=GROCERY",
    );
    expect(refreshUrl(MARKETS.cz)).toBe(
      "https://www.itesco.cz/account/auth/cs-CZ/refresh-token?soft-refresh=false" +
        "&from=https%3A%2F%2Fnakup.itesco.cz%2Fshop%2Fcs-CZ%2Flanding%2Fgroceries",
    );
  });

  it("matches cookie domains on label boundaries", () => {
    expect(isMarketCookieDomain(MARKETS.cz, ".itesco.cz")).toBe(true);
    expect(isMarketCookieDomain(MARKETS.cz, "nakup.itesco.cz")).toBe(true);
    expect(isMarketCookieDomain(MARKETS.uk, ".tesco.com")).toBe(true);
    expect(isMarketCookieDomain(MARKETS.uk, ".itesco.cz")).toBe(false);
    expect(isMarketCookieDomain(MARKETS.uk, "nottesco.com")).toBe(false);
  });
});

describe("transport routing", () => {
  it("sends UK headers by default", async () => {
    const { impl, calls } = stubFetch([{ body: EMPTY_BASKET }]);
    await new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl }).basket.get();
    expect(calls[0]!.headers).toMatchObject({
      region: "UK",
      language: "en-GB",
      "accept-language": "en-GB",
    });
  });

  it("routes to the configured market", async () => {
    const { impl, calls } = stubFetch([{ body: EMPTY_BASKET }]);
    const client = new Basketeer({
      market: "cz",
      session: SESSION,
      throttleMs: 0,
      fetchImpl: impl,
    });
    await client.basket.get();
    expect(client.market).toBe(MARKETS.cz);
    expect(calls[0]!.headers).toMatchObject({
      region: "CZ",
      language: "cs-CZ",
      "accept-language": "cs-CZ",
    });
  });

  it("returns the market's checkout URL", async () => {
    const { impl } = stubFetch([{ body: EMPTY_BASKET }]);
    const client = new Basketeer({
      market: "cz",
      session: SESSION,
      throttleMs: 0,
      fetchImpl: impl,
    });
    expect((await client.checkout()).url).toBe(checkoutUrl(MARKETS.cz));
  });
});

describe("market-scoped sessions", () => {
  const cookies = [
    { name: "OAuth.AccessToken", value: "uk-token", domain: ".tesco.com" },
    { name: "UUID", value: "uk-uuid", domain: ".tesco.com" },
    { name: "OAuth.AccessToken", value: "cz-token", domain: ".itesco.cz" },
    { name: "UUID", value: "cz-uuid", domain: ".itesco.cz" },
    { name: "_abck", value: "cz-akamai", domain: ".itesco.cz" },
  ];

  it("harvests only the market's cookies and stamps the session", () => {
    const s = sessionFromCookies(cookies, { market: MARKETS.cz });
    expect(s).toMatchObject({ accessToken: "cz-token", customerUuid: "cz-uuid", market: "cz" });
    expect(s.cookies).toEqual({
      "OAuth.AccessToken": "cz-token",
      UUID: "cz-uuid",
      _abck: "cz-akamai",
    });
  });

  it("keeps cookies without a domain", () => {
    const plain = [
      { name: "OAuth.AccessToken", value: "t" },
      { name: "UUID", value: "u" },
    ];
    expect(sessionFromCookies(plain).market).toBeUndefined();
    expect(sessionFromCookies(plain, { market: MARKETS.cz })).toMatchObject({
      accessToken: "t",
      market: "cz",
    });
  });

  it("rejects a session from another market", async () => {
    const czSession = { ...SESSION, market: "cz" };
    expect(() => new Basketeer({ session: czSession })).toThrow(MarketMismatchError);

    const manager = new SessionManager({ market: MARKETS.uk });
    await expect(manager.setSession(czSession)).rejects.toThrow(MarketMismatchError);

    const store = new MemoryTokenStore();
    await store.save(czSession);
    await expect(new SessionManager({ store }).load()).rejects.toThrow(MarketMismatchError);
  });

  it("accepts unstamped sessions on any market and never stamps them", async () => {
    for (const market of [MARKETS.uk, MARKETS.cz]) {
      const store = new MemoryTokenStore();
      await store.save(SESSION);
      const manager = new SessionManager({ market, store });
      expect(await manager.load()).toEqual(SESSION);
      await manager.setSession(SESSION);
      expect((await store.load())?.market).toBeUndefined();
    }
  });

  it("rejects an auth backend for another market before any sign-in", () => {
    const backend: AuthBackend = {
      market: MARKETS.uk,
      login: async () => {
        throw new Error("must not be called");
      },
      refresh: async (s) => s,
    };
    expect(() => new Basketeer({ market: "cz", authBackend: backend })).toThrow(
      MarketMismatchError,
    );
    expect(() => new Basketeer({ market: "uk", authBackend: backend })).not.toThrow();
  });

  it("keeps the UK session path and gives other markets their own file", () => {
    expect(new FileTokenStore()).toEqual(new FileTokenStore(defaultSessionPath()));
    expect(new FileTokenStore({ market: "cz" })).toEqual(
      new FileTokenStore(defaultSessionPath(MARKETS.cz)),
    );
    expect(defaultSessionPath()).toMatch(/[/\\]\.basketeer[/\\]session\.json$/);
    expect(defaultSessionPath(MARKETS.cz)).toMatch(/[/\\]\.basketeer[/\\]session\.cz\.json$/);
  });
});

describe("isoDate", () => {
  afterEach(() => vi.useRealTimers());

  it("uses the storefront's calendar day", () => {
    vi.useFakeTimers();
    // 23:30 UTC on 31 Dec is already 1 Jan in Prague.
    vi.setSystemTime(new Date("2026-12-31T23:30:00Z"));
    expect(isoDate(0, "Europe/London")).toBe("2026-12-31");
    expect(isoDate(0, "Europe/Prague")).toBe("2027-01-01");
    expect(isoDate(6, "Europe/Prague")).toBe("2027-01-07");
  });

  it("is not shifted by DST transitions", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T22:30:00Z")); // 00:30 on 25 Oct in Prague, DST ends that night
    expect(isoDate(1, "Europe/Prague")).toBe("2026-10-26");
  });
});
