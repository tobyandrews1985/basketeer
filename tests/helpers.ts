import { Basketeer } from "../src/client.js";
import type { Session } from "../src/models.js";

export interface StubResponse {
  status?: number;
  body: unknown;
}

export interface RecordedCall {
  headers: Record<string, string>;
  /** Parsed JSON request body (a GraphQL op array). `any` for terse assertions. */
  body: any;
  at: number;
}

/** A `fetch` stub that returns queued responses and records each request. */
export function stubFetch(responses: StubResponse[]) {
  const calls: RecordedCall[] = [];
  let i = 0;
  const impl = (async (_url: string, init: RequestInit) => {
    calls.push({
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string),
      at: Date.now(),
    });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    const payload = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(payload, { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

export const SESSION: Session = {
  accessToken: "header.payload.sig",
  customerUuid: "uuid-123",
  cookies: { "OAuth.AccessToken": "header.payload.sig", UUID: "uuid-123", _abck: "x" },
};

/** Minimal nutrition rows that yield a known per_100g protein value. */
function nutritionRows(proteinG: number): unknown[] {
  return [
    { name: "Typical Values", value1: "Per 100g", value2: null, value3: null },
    { name: "Protein", value1: `${proteinG}g`, value2: null, value3: null },
    { name: "Fat", value1: "1g", value2: null, value3: null },
    { name: "Carbohydrate", value1: "1g", value2: null, value3: null },
    { name: "Salt", value1: "0.1g", value2: null, value3: null },
  ];
}

function productResponse(sku: string, proteinG: number): StubResponse {
  return {
    body: [
      {
        data: {
          product: {
            tpnc: sku,
            tpnb: sku,
            title: `Product ${sku}`,
            brandName: "TestBrand",
            price: { actual: 1.0, unitPrice: 1.0, unitOfMeasure: "kg" },
            promotions: [],
            details: { packSize: null, nutrition: nutritionRows(proteinG), ingredients: [] },
          },
        },
      },
    ],
  };
}

/** A product detail response with no `product` — `getProduct` treats this as NotFound. */
function notFoundResponse(): StubResponse {
  return { body: [{ data: { product: null } }] };
}

/** A 429 response — the transport maps this to RateLimitedError. */
function rateLimitResponse(): StubResponse {
  return { status: 429, body: "Too Many Requests" };
}

/** A search node with the given SKU, shaped like the live ProductInterface node. */
function searchNode(sku: string) {
  return {
    node: {
      __typename: "ProductType",
      tpnc: sku,
      tpnb: sku,
      title: `Product ${sku}`,
      brandName: "TestBrand",
      sellers: {
        results: [{ price: { actual: 1.0, unitPrice: 1.0, unitOfMeasure: "kg" }, promotions: [] }],
      },
    },
  };
}

function searchResponseFor(skus: string[]): StubResponse {
  return { body: [{ data: { search: { results: skus.map(searchNode) } } }] };
}

/**
 * A Basketeer whose search returns `skus`, then product detail responses are drawn
 * from `details` keyed by SKU (a number → protein per_100g, "404" → NotFound, "429" → RateLimited).
 * Responses are queued in SKU order, so call `searchByNutrition` with a matching hydrate cap.
 */
export function makeNutritionClientWith(
  skus: string[],
  details: Record<string, number | "404" | "429">,
): Basketeer {
  const responses: StubResponse[] = [searchResponseFor(skus)];
  for (const sku of skus) {
    const d = details[sku];
    if (d === "429") responses.push(rateLimitResponse());
    else responses.push(d === "404" || d === undefined ? notFoundResponse() : productResponse(sku, d));
  }
  const { impl } = stubFetch(responses);
  return new Basketeer({ throttleMs: 0, fetchImpl: impl });
}

/**
 * Returns a Basketeer (throttleMs: 0) whose fetchImpl answers:
 * - Search("protein") → 3 results with SKUs a, b, c
 * - GetProduct("a") → protein 25 per_100g
 * - GetProduct("b") → protein 10 per_100g
 * - GetProduct("c") → protein 30 per_100g
 */
export function makeNutritionClient(): Basketeer {
  const searchResponse: StubResponse = {
    body: [
      {
        data: {
          search: {
            results: [
              {
                node: {
                  __typename: "ProductType",
                  tpnc: "a",
                  tpnb: "a",
                  title: "Product a",
                  brandName: "TestBrand",
                  sellers: {
                    results: [
                      {
                        price: { actual: 1.0, unitPrice: 1.0, unitOfMeasure: "kg" },
                        promotions: [],
                      },
                    ],
                  },
                },
              },
              {
                node: {
                  __typename: "ProductType",
                  tpnc: "b",
                  tpnb: "b",
                  title: "Product b",
                  brandName: "TestBrand",
                  sellers: {
                    results: [
                      {
                        price: { actual: 1.0, unitPrice: 1.0, unitOfMeasure: "kg" },
                        promotions: [],
                      },
                    ],
                  },
                },
              },
              {
                node: {
                  __typename: "ProductType",
                  tpnc: "c",
                  tpnb: "c",
                  title: "Product c",
                  brandName: "TestBrand",
                  sellers: {
                    results: [
                      {
                        price: { actual: 1.0, unitPrice: 1.0, unitOfMeasure: "kg" },
                        promotions: [],
                      },
                    ],
                  },
                },
              },
            ],
          },
        },
      },
    ],
  };

  const { impl } = stubFetch([
    searchResponse,
    productResponse("a", 25),
    productResponse("b", 10),
    productResponse("c", 30),
  ]);

  return new Basketeer({ throttleMs: 0, fetchImpl: impl });
}
