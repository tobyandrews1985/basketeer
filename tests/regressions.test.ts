import { describe, expect, it } from "vitest";
import type { AuthBackend } from "../src/auth/types.js";
import { Basketeer } from "../src/client.js";
import { AuthExpiredError, GraphQLRequestError } from "../src/errors.js";
import { categoryFacet } from "../src/operations.js";
import { isoDate, parseProductNode, parsePromotions } from "../src/parsers.js";
import { UPDATE_BASKET } from "../src/queries.js";
import { SESSION, stubFetch } from "./helpers.js";

describe("parsers are defensive", () => {
  it("parsePromotions tolerates null / non-object array elements", () => {
    const out = parsePromotions([null, undefined, "x", { description: "Real", price: null }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.description).toBe("Real");
    expect(out[0]!.priceAfterDiscount).toBeNull();
  });

  it("parseProductNode returns null for missing tpnc / null node (no phantom SKU)", () => {
    expect(parseProductNode(null)).toBeNull();
    expect(parseProductNode({})).toBeNull();
    expect(parseProductNode({ __typename: "NotAProduct" })).toBeNull();
    expect(parseProductNode({ tpnc: "1", title: "T" })?.sku).toBe("1");
    expect(parseProductNode({ tpnc: "1", defaultImageUrl: 123 })?.imageUrl).toBeNull();
  });

  it("search drops null edges and tpnc-less nodes instead of fabricating results", async () => {
    const body = [
      {
        data: {
          search: {
            results: [
              { node: null },
              { node: { __typename: "ProductType", tpnc: "1", title: "Milk" } },
              { node: { __typename: "AdType" } }, // no tpnc
            ],
          },
        },
      },
    ];
    const { impl } = stubFetch([{ body }]);
    const t = new Basketeer({ throttleMs: 0, fetchImpl: impl });
    const { results } = await t.search("milk");
    expect(results).toHaveLength(1);
    expect(results[0]!.sku).toBe("1");
  });
});

describe("isoDate / categoryFacet", () => {
  it("isoDate is a local YYYY-MM-DD and respects the offset", () => {
    expect(isoDate(0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const day = 86_400_000;
    const d0 = new Date(`${isoDate(0)}T00:00:00`);
    const d6 = new Date(`${isoDate(6)}T00:00:00`);
    expect(Math.round((d6.getTime() - d0.getTime()) / day)).toBe(6);
  });

  it("categoryFacet encodes a department name as b;<base64>", () => {
    expect(categoryFacet("Fresh Food")).toBe("b;RnJlc2ggRm9vZA==");
  });
});

describe("transport hardening", () => {
  it("throttles concurrent calls serially (not all at once)", async () => {
    const { impl, calls } = stubFetch([{ body: [{ data: { search: { results: [] } } }] }]);
    const t = new Basketeer({ throttleMs: 40, fetchImpl: impl });
    await Promise.all([t.search("a"), t.search("b"), t.search("c")]);
    expect(calls).toHaveLength(3);
    // Without a real gate these fire within ~1ms; with it they're ~throttleMs apart.
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(25);
    expect(calls[2]!.at - calls[1]!.at).toBeGreaterThanOrEqual(25);
  });

  it("throws AuthExpiredError (not GraphQLRequestError) when a refresh still 401s", async () => {
    const unauthorized = [
      { errors: [{ message: "unauthorized", extensions: { http: { status: 401 } } }] },
    ];
    const { impl } = stubFetch([{ body: unauthorized }]); // every attempt is 401
    const backend: AuthBackend = {
      login: async () => SESSION,
      refresh: async () => SESSION, // refresh "succeeds" but token still rejected
    };
    const t = new Basketeer({
      session: SESSION,
      authBackend: backend,
      throttleMs: 0,
      fetchImpl: impl,
    });
    await expect(t.basket.get()).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it("scrubs secrets and stays short in GraphQLRequestError messages", () => {
    const e = new GraphQLRequestError([
      { message: "bad token eyJhbGciOiJIUzI1NiJ9.payloadpayload.sig" },
      { message: "second" },
    ]);
    expect(e.message).toContain("«jwt»");
    expect(e.message).not.toContain("eyJhbGci");
    expect(e.message).toContain("(+1 more)");
    expect(e.errors).toHaveLength(2); // raw detail preserved on the object
  });
});

describe("basket write returns a full-fidelity basket", () => {
  it("UPDATE_BASKET selects the same fields as GET_BASKET", () => {
    for (const field of ["guidePrice", "isInAmend", "amendExpiry", "shoppingMethod"]) {
      expect(UPDATE_BASKET).toContain(field);
    }
  });

  it("basket.set parses guidePrice / isInAmend / amendExpiry from the write response", async () => {
    const body = [
      {
        data: {
          basket: {
            id: "b1",
            guidePrice: 41.5,
            isInAmend: true,
            amendExpiry: "2026-06-05T22:00:00Z",
            shoppingMethod: "delivery",
            items: [],
            updates: { items: [] },
          },
        },
      },
    ];
    const { impl } = stubFetch([{ body }]);
    const t = new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl });
    const basket = await t.basket.set("111", 1);
    expect(basket.guidePrice).toBe(41.5);
    expect(basket.isInAmend).toBe(true);
    expect(basket.amendExpiry).toBe("2026-06-05T22:00:00Z");
  });
});

describe("raw HTTP 401 triggers refresh", () => {
  it("refreshes once on a raw HTTP 401 and retries", async () => {
    const PRODUCT_NODE = {
      tpnc: "123",
      tpnb: "123",
      title: "Test Product",
      brandName: "TestBrand",
      defaultImageUrl: "https://digitalcontent.api.tesco.com/v2/media/ghs/test.jpeg?h=225&w=225",
      price: { actual: 1.0, unitPrice: 1.0, unitOfMeasure: "kg" },
      promotions: [],
      details: { packSize: null, nutrition: [], ingredients: [] },
    };

    let calls = 0;
    let refreshed = 0;
    const impl = (async () => {
      calls++;
      if (calls === 1) {
        return new Response("Unauthorized", { status: 401 }); // raw, non-JSON
      }
      return new Response(JSON.stringify([{ data: { product: PRODUCT_NODE } }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const backend: AuthBackend = {
      login: async () => SESSION,
      refresh: async () => {
        refreshed++;
        return SESSION;
      },
    };
    const t = new Basketeer({
      session: SESSION,
      authBackend: backend,
      throttleMs: 0,
      fetchImpl: impl,
    });

    await t.getProduct("123");
    expect(refreshed).toBe(1);
    expect(calls).toBe(2);
  });
});
