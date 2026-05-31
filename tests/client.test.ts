import { describe, it, expect } from "vitest";
import { Basketeer } from "../src/client.js";
import { ApiKeyError, RateLimitedError, LineRejectedError, AuthExpiredError } from "../src/errors.js";
import type { AuthBackend } from "../src/auth/types.js";
import { stubFetch, SESSION } from "./helpers.js";

const SEARCH_BODY = [
  {
    data: {
      search: {
        results: [
          {
            node: {
              __typename: "ProductType",
              tpnc: "254656543",
              tpnb: "54550994",
              title: "Tesco British Semi Skimmed Milk 2.272L, 4 Pints",
              brandName: "TESCO",
              sellers: {
                results: [
                  {
                    price: { actual: 1.65, unitPrice: 0.73, unitOfMeasure: "litre" },
                    promotions: [
                      {
                        description: "£2.25 Clubcard Price",
                        startDate: null,
                        endDate: null,
                        attributes: ["CLUBCARD_PRICING"],
                        price: { afterDiscount: 1.65, beforeDiscount: null },
                      },
                    ],
                  },
                ],
              },
            },
          },
        ],
      },
    },
  },
];

const PRODUCT_PACKAGED = [
  {
    data: {
      product: {
        tpnc: "282822189",
        tpnb: "111",
        title: "Coca-Cola 1.75L",
        brandName: "Coca-Cola",
        price: { actual: 2.49, unitPrice: 1.42, unitOfMeasure: "litre" },
        promotions: [],
        details: { packSize: [{ value: "1750", units: "ML" }], nutrition: [], ingredients: [] },
      },
    },
  },
];

const PRODUCT_LOOSE = [
  {
    data: {
      product: {
        tpnc: "275280804",
        tpnb: "222",
        title: "Tesco Bananas Loose",
        brandName: "TESCO",
        price: { actual: 0.17, unitPrice: 1.1, unitOfMeasure: "kg" },
        promotions: [],
        details: { packSize: null, nutrition: [], ingredients: [] },
      },
    },
  },
];

describe("request assembly", () => {
  it("sends the xapi header set and a JSON-array body with mfeName", async () => {
    const { impl, calls } = stubFetch([{ body: SEARCH_BODY }]);
    const t = new Basketeer({ throttleMs: 0, fetchImpl: impl });
    await t.search("milk");

    const { headers, body } = calls[0]!;
    expect(headers["x-apikey"]).toBeTruthy();
    expect(headers["region"]).toBe("UK");
    expect(headers["language"]).toBe("en-GB");
    expect(headers["traceid"]).toMatch(/^[0-9a-f-]+:[0-9a-f-]+$/);
    expect(headers["trkid"]).toMatch(/^[0-9a-f-]+$/);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].operationName).toBe("Search");
    expect(body[0].extensions.mfeName).toBe("mfe-plp");
  });

  it("omits auth headers when anonymous", async () => {
    const { impl, calls } = stubFetch([{ body: SEARCH_BODY }]);
    const t = new Basketeer({ throttleMs: 0, fetchImpl: impl });
    await t.search("milk");
    expect(calls[0]!.headers["authorization"]).toBeUndefined();
    expect(calls[0]!.headers["customer-uuid"]).toBeUndefined();
  });

  it("injects Bearer + customer-uuid + cookie when a session is present", async () => {
    const { impl, calls } = stubFetch([{ body: [{ data: { basket: { id: "b1", items: [] } } }] }]);
    const t = new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl });
    await t.basket.get();
    const h = calls[0]!.headers;
    expect(h["authorization"]).toBe("Bearer header.payload.sig");
    expect(h["customer-uuid"]).toBe("uuid-123");
    expect(h["cookie"]).toContain("OAuth.AccessToken=header.payload.sig");
    expect(h["cookie"]).toContain("_abck=x");
  });
});

describe("parsing", () => {
  it("parses search results incl. nullable promotion.beforeDiscount", async () => {
    const { impl } = stubFetch([{ body: SEARCH_BODY }]);
    const t = new Basketeer({ throttleMs: 0, fetchImpl: impl });
    const { results } = await t.search("milk");
    const r = results[0];
    expect(r!.sku).toBe("254656543");
    expect(r!.price.actual).toBe(1.65);
    expect(r!.onOffer).toBe(true);
    expect(r!.promotions[0]!.priceBeforeDiscount).toBeNull();
    expect(r!.promotions[0]!.priceAfterDiscount).toBe(1.65);
  });

  it("coerces packSize array (string value, uppercase units) to a number", async () => {
    const { impl } = stubFetch([{ body: PRODUCT_PACKAGED }]);
    const t = new Basketeer({ throttleMs: 0, fetchImpl: impl });
    const p = await t.getProduct("282822189");
    expect(p.packSize).toEqual({ value: 1750, units: "ML" });
  });

  it("handles null packSize (loose produce) without throwing", async () => {
    const { impl } = stubFetch([{ body: PRODUCT_LOOSE }]);
    const t = new Basketeer({ throttleMs: 0, fetchImpl: impl });
    const p = await t.getProduct("275280804");
    expect(p.packSize).toBeNull();
    expect(p.price.actual).toBe(0.17);
  });
});

describe("error taxonomy", () => {
  it('maps 403 "Invalid Client" to ApiKeyError', async () => {
    const { impl } = stubFetch([{ status: 403, body: "Forbidden: Invalid Client" }]);
    const t = new Basketeer({ throttleMs: 0, fetchImpl: impl });
    await expect(t.search("milk")).rejects.toBeInstanceOf(ApiKeyError);
  });

  it("maps a generic 403 to RateLimitedError", async () => {
    const { impl } = stubFetch([{ status: 403, body: "Access Denied" }]);
    const t = new Basketeer({ throttleMs: 0, fetchImpl: impl });
    await expect(t.search("milk")).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("maps 429 to RateLimitedError", async () => {
    const { impl } = stubFetch([{ status: 429, body: "slow down" }]);
    const t = new Basketeer({ throttleMs: 0, fetchImpl: impl });
    await expect(t.search("milk")).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("throws LineRejectedError when a basket line is unsuccessful", async () => {
    const body = [
      { data: { basket: { id: "b1", items: [], updates: { items: [{ id: "999", successful: false }] } } } },
    ];
    const { impl } = stubFetch([{ body }]);
    const t = new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl });
    await expect(t.basket.set("999", 1)).rejects.toBeInstanceOf(LineRejectedError);
  });
});

describe("401 refresh-and-retry", () => {
  it("refreshes once on 401 then retries successfully", async () => {
    const unauthorized = [{ errors: [{ message: "unauthorized", extensions: { http: { status: 401 } } }] }];
    const ok = [{ data: { basket: { id: "b1", items: [] } } }];
    const { impl, calls } = stubFetch([{ body: unauthorized }, { body: ok }]);

    let refreshed = 0;
    const backend: AuthBackend = {
      login: async () => SESSION,
      refresh: async () => {
        refreshed++;
        return { ...SESSION, accessToken: "new.token.sig" };
      },
    };
    const t = new Basketeer({ session: SESSION, authBackend: backend, throttleMs: 0, fetchImpl: impl });
    const basket = await t.basket.get();
    expect(refreshed).toBe(1);
    expect(calls.length).toBe(2);
    expect(basket.id).toBe("b1");
    // retried call carried the refreshed bearer
    expect(calls[1]!.headers["authorization"]).toBe("Bearer new.token.sig");
  });

  it("throws AuthExpiredError when refresh is impossible (no backend)", async () => {
    const unauthorized = [{ errors: [{ message: "unauthorized", extensions: { http: { status: 401 } } }] }];
    const { impl } = stubFetch([{ body: unauthorized }]);
    const t = new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl });
    await expect(t.basket.get()).rejects.toBeInstanceOf(AuthExpiredError);
  });
});
