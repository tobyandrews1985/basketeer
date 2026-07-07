import { describe, expect, it } from "vitest";
import type { AuthBackend } from "../src/auth/types.js";
import { Basketeer } from "../src/client.js";
import {
  ApiKeyError,
  AuthExpiredError,
  LineRejectedError,
  RateLimitedError,
} from "../src/errors.js";
import { makeNutritionClient, makeNutritionClientWith, SESSION, stubFetch } from "./helpers.js";

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
              defaultImageUrl:
                "https://digitalcontent.api.tesco.com/v2/media/ghs/milk.jpeg?h=225&w=225",
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
        defaultImageUrl: "https://digitalcontent.api.tesco.com/v2/media/ghs/coke.jpeg?h=225&w=225",
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
        defaultImageUrl: null,
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
    expect(r!.imageUrl).toBe(
      "https://digitalcontent.api.tesco.com/v2/media/ghs/milk.jpeg?h=225&w=225",
    );
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
    expect(p.imageUrl).toBe(
      "https://digitalcontent.api.tesco.com/v2/media/ghs/coke.jpeg?h=225&w=225",
    );
  });

  it("handles null packSize (loose produce) without throwing", async () => {
    const { impl } = stubFetch([{ body: PRODUCT_LOOSE }]);
    const t = new Basketeer({ throttleMs: 0, fetchImpl: impl });
    const p = await t.getProduct("275280804");
    expect(p.imageUrl).toBeNull();
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
      {
        data: {
          basket: { id: "b1", items: [], updates: { items: [{ id: "999", successful: false }] } },
        },
      },
    ];
    const { impl } = stubFetch([{ body }]);
    const t = new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl });
    await expect(t.basket.set("999", 1)).rejects.toBeInstanceOf(LineRejectedError);
  });

  it("throws ItemUnavailableError and rolls back when an added line is not for sale", async () => {
    const unavailable = {
      data: {
        basket: {
          id: "b1",
          items: [{ id: "L1", quantity: 1, product: { id: "777", isForSale: false } }],
          updates: { items: [{ id: "777", successful: true }] },
        },
      },
    };
    const rolledBack = { data: { basket: { id: "b1", items: [], updates: { items: [] } } } };
    const { impl, calls } = stubFetch([{ body: [unavailable] }, { body: [rolledBack] }]);
    const t = new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl });

    await expect(t.basket.set("777", 1)).rejects.toMatchObject({
      name: "ItemUnavailableError",
      skus: ["777"],
    });
    // Two calls: the add, then a rollback setting the line to 0.
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body[0].variables.items[0]).toMatchObject({ id: "777", newValue: 0 });
  });

  it("does not flag an available added line", async () => {
    const body = [
      {
        data: {
          basket: {
            id: "b1",
            items: [{ id: "L1", quantity: 1, product: { id: "555", isForSale: true } }],
            updates: { items: [{ id: "555", successful: true }] },
          },
        },
      },
    ];
    const { impl } = stubFetch([{ body }]);
    const t = new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl });
    const basket = await t.basket.set("555", 1);
    expect(basket.items[0]!.available).toBe(true);
  });

  it("batch update reports a rejected line on the result instead of throwing", async () => {
    const body = [
      {
        data: {
          basket: {
            id: "b1",
            items: [{ id: "L1", quantity: 1, product: { id: "111", isForSale: true } }],
            updates: {
              items: [
                { id: "111", successful: true },
                { id: "999", successful: false },
              ],
            },
          },
        },
      },
    ];
    const { impl } = stubFetch([{ body }]);
    const t = new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl });
    const result = await t.basket.update([
      { id: "111", newValue: 1 },
      { id: "999", newValue: 1 },
    ]);
    expect(result.rejected).toEqual(["999"]);
    expect(result.unavailable).toEqual([]);
    expect(result.basket.items[0]!.sku).toBe("111");
  });

  it("batch update rolls back unavailable lines and reports them on the result", async () => {
    const mixed = {
      data: {
        basket: {
          id: "b1",
          items: [
            { id: "L1", quantity: 1, product: { id: "111", isForSale: true } },
            { id: "L2", quantity: 1, product: { id: "777", isForSale: false } },
          ],
          updates: {
            items: [
              { id: "111", successful: true },
              { id: "777", successful: true },
            ],
          },
        },
      },
    };
    const rolledBack = {
      data: {
        basket: {
          id: "b1",
          items: [{ id: "L1", quantity: 1, product: { id: "111", isForSale: true } }],
          updates: { items: [{ id: "777", successful: true }] },
        },
      },
    };
    const { impl, calls } = stubFetch([{ body: [mixed] }, { body: [rolledBack] }]);
    const t = new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl });

    const result = await t.basket.update([
      { id: "111", newValue: 1 },
      { id: "777", newValue: 1 },
    ]);
    expect(result.unavailable).toEqual(["777"]);
    expect(result.rejected).toEqual([]);
    // The returned basket is the post-rollback one: the doomed line is gone.
    expect(result.basket.items.map((l) => l.sku)).toEqual(["111"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body[0].variables.items[0]).toMatchObject({ id: "777", newValue: 0 });
  });

  it("batch update within an amend passes the orderId through to the rollback", async () => {
    const unavailable = {
      data: {
        basket: {
          id: "b1",
          items: [{ id: "L1", quantity: 1, product: { id: "777", isForSale: false } }],
          updates: { items: [{ id: "777", successful: true }] },
        },
      },
    };
    const rolledBack = { data: { basket: { id: "b1", items: [], updates: { items: [] } } } };
    const { impl, calls } = stubFetch([{ body: [unavailable] }, { body: [rolledBack] }]);
    const t = new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl });

    await t.basket.update([{ id: "777", newValue: 1 }], "order-42");
    expect(calls[1]!.body[0].variables).toMatchObject({ orderId: "order-42" });
  });
});

describe("401 refresh-and-retry", () => {
  it("refreshes once on 401 then retries successfully", async () => {
    const unauthorized = [
      { errors: [{ message: "unauthorized", extensions: { http: { status: 401 } } }] },
    ];
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
    const t = new Basketeer({
      session: SESSION,
      authBackend: backend,
      throttleMs: 0,
      fetchImpl: impl,
    });
    const basket = await t.basket.get();
    expect(refreshed).toBe(1);
    expect(calls.length).toBe(2);
    expect(basket.id).toBe("b1");
    // retried call carried the refreshed bearer
    expect(calls[1]!.headers["authorization"]).toBe("Bearer new.token.sig");
  });

  it("throws AuthExpiredError when refresh is impossible (no backend)", async () => {
    const unauthorized = [
      { errors: [{ message: "unauthorized", extensions: { http: { status: 401 } } }] },
    ];
    const { impl } = stubFetch([{ body: unauthorized }]);
    const t = new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl });
    await expect(t.basket.get()).rejects.toBeInstanceOf(AuthExpiredError);
  });
});

describe("searchByNutrition", () => {
  it("hydrates results, filters by nutrition, and reports counts", async () => {
    const client = makeNutritionClient();

    const out = await client.searchByNutrition("protein", {
      where: { protein: { min: 20 } },
      sort: { by: "protein", dir: "desc" },
      hydrate: 3,
    });

    expect(out.hydrated).toBe(3);
    expect(out.results.map((p) => p.sku)).toEqual(["c", "a"]); // b filtered out (protein=10), sorted desc
    expect(out.failed).toBe(0);
    // a full page (3 returned for a cap of 3) reports hasMore via search's heuristic
    expect(out.hasMore).toBe(true);
  });

  it("skips a failed product fetch instead of rejecting the whole call", async () => {
    // b's detail 404s; a and c hydrate fine.
    const client = makeNutritionClientWith(["a", "b", "c"], { a: 25, b: "404", c: 30 });

    const out = await client.searchByNutrition("protein", { hydrate: 3 });

    expect(out.hydrated).toBe(2); // a and c
    expect(out.failed).toBeGreaterThanOrEqual(1);
    expect(out.results.map((p) => p.sku).sort()).toEqual(["a", "c"]);
  });

  it("respects the hydrate cap and reports hasMore", async () => {
    // 6 search hits, hydrate only 3 → 3 hydrated, catalogue had more.
    const client = makeNutritionClientWith(["a", "b", "c", "d", "e", "f"], {
      a: 25,
      b: 10,
      c: 30,
      d: 5,
      e: 15,
      f: 20,
    });

    const out = await client.searchByNutrition("protein", { hydrate: 3 });

    expect(out.hydrated).toBe(3);
    expect(out.hasMore).toBe(true);
    expect(out.failed).toBe(0);
  });

  it("soft-skips NotFoundError (discontinued SKU) without rejecting", async () => {
    // b's detail 404s → NotFoundError; a and c hydrate fine.
    const client = makeNutritionClientWith(["a", "b", "c"], { a: 25, b: "404", c: 30 });

    const out = await client.searchByNutrition("protein", { hydrate: 3 });

    expect(out.failed).toBeGreaterThanOrEqual(1);
    expect(out.hydrated).toBe(2);
    expect(out.results.map((p) => p.sku).sort()).toEqual(["a", "c"]);
  });

  it("propagates RateLimitedError instead of swallowing it", async () => {
    // a hydrates fine; b triggers a 429 → must reject the whole call.
    const client = makeNutritionClientWith(["a", "b", "c"], { a: 25, b: "429", c: 30 });

    await expect(client.searchByNutrition("protein", { hydrate: 3 })).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });
});

describe("numeric input validation", () => {
  it("search rejects with RangeError for negative limit", async () => {
    const t = new Basketeer({ throttleMs: 0 });
    await expect(t.search("x", { limit: -1 })).rejects.toThrow(RangeError);
  });

  it("search rejects with RangeError for zero page", async () => {
    const t = new Basketeer({ throttleMs: 0 });
    await expect(t.search("x", { page: 0 })).rejects.toThrow(RangeError);
  });

  it("search rejects with RangeError for fractional limit", async () => {
    const t = new Basketeer({ throttleMs: 0 });
    await expect(t.search("x", { limit: 1.5 })).rejects.toThrow(RangeError);
  });

  it("searchByNutrition rejects with RangeError for hydrate=0", async () => {
    const t = new Basketeer({ throttleMs: 0 });
    await expect(t.searchByNutrition("x", { hydrate: 0 })).rejects.toThrow(RangeError);
  });

  it("searchByNutrition rejects with RangeError for negative limit", async () => {
    const t = new Basketeer({ throttleMs: 0 });
    await expect(t.searchByNutrition("x", { limit: -5 })).rejects.toThrow(RangeError);
  });

  it("basket.add rejects with RangeError for negative quantity", async () => {
    const t = new Basketeer({ session: SESSION, throttleMs: 0 });
    await expect(t.basket.add("sku", -2)).rejects.toThrow(RangeError);
  });

  it("basket.add rejects with RangeError for zero quantity", async () => {
    const t = new Basketeer({ session: SESSION, throttleMs: 0 });
    await expect(t.basket.add("sku", 0)).rejects.toThrow(RangeError);
  });

  it("basket.set throws RangeError for negative quantity", () => {
    const t = new Basketeer({ session: SESSION, throttleMs: 0 });
    expect(() => t.basket.set("sku", -1)).toThrow(RangeError);
  });

  it("basket.set accepts 0 (removes line) without throwing", async () => {
    const body = [{ data: { basket: { id: "b1", items: [], updates: { items: [] } } } }];
    const { impl } = stubFetch([{ body }]);
    const t = new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl });
    await expect(t.basket.set("sku", 0)).resolves.toBeDefined();
  });

  it("search with valid limit resolves without throwing", async () => {
    const { impl } = stubFetch([{ body: SEARCH_BODY }]);
    const t = new Basketeer({ throttleMs: 0, fetchImpl: impl });
    await expect(t.search("milk", { limit: 5 })).resolves.toBeDefined();
  });

  it("browseCategory rejects with RangeError for negative limit", async () => {
    const t = new Basketeer({ throttleMs: 0 });
    await expect(t.browseCategory("b;x", { limit: -1 })).rejects.toThrow(RangeError);
  });

  it("browseCategory rejects with RangeError for zero page", async () => {
    const t = new Basketeer({ throttleMs: 0 });
    await expect(t.browseCategory("b;x", { page: 0 })).rejects.toThrow(RangeError);
  });

  it("favourites rejects with RangeError for fractional page", async () => {
    const t = new Basketeer({ session: SESSION, throttleMs: 0 });
    await expect(t.favourites({ page: 1.5 })).rejects.toThrow(RangeError);
  });

  it("basket.update rejects with RangeError for negative quantity", async () => {
    const t = new Basketeer({ session: SESSION, throttleMs: 0 });
    await expect(t.basket.update([{ id: "sku", newValue: -1 }])).rejects.toThrow(RangeError);
  });

  it("basket.update rejects with RangeError for NaN quantity", async () => {
    const t = new Basketeer({ session: SESSION, throttleMs: 0 });
    await expect(t.basket.update([{ id: "sku", newValue: Number.NaN }])).rejects.toThrow(
      RangeError,
    );
  });

  it("basket.update accepts a fractional quantity (weight-priced line)", async () => {
    const body = [{ data: { basket: { id: "b1", items: [], updates: { items: [] } } } }];
    const { impl } = stubFetch([{ body }]);
    const t = new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl });
    await expect(
      t.basket.update([{ id: "sku", newValue: 1.5, newUnitChoice: "kg" }]),
    ).resolves.toBeDefined();
  });
});
