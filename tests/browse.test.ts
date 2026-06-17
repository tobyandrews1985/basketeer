import { describe, expect, it } from "vitest";
import { Basketeer } from "../src/client.js";
import { SESSION, stubFetch } from "./helpers.js";

/** Favourites returns bare ProductInterface nodes under favourites.products[]. */
const FAVOURITES_BODY = [
  {
    data: {
      favourites: {
        products: [
          {
            __typename: "ProductType",
            tpnc: "111",
            tpnb: "11",
            title: "Tesco Semi Skimmed Milk",
            brandName: "TESCO",
            defaultImageUrl:
              "https://digitalcontent.api.tesco.com/v2/media/ghs/milk.jpeg?h=225&w=225",
            sellers: {
              results: [
                {
                  price: { actual: 1.45, unitPrice: 0.64, unitOfMeasure: "litre" },
                  promotions: [],
                },
              ],
            },
          },
        ],
      },
    },
  },
];

/** Category wraps each node under results[].node (like Search). */
const CATEGORY_BODY = [
  {
    data: {
      category: {
        results: [
          {
            node: {
              __typename: "ProductType",
              tpnc: "222",
              tpnb: "22",
              title: "Tesco Bananas Loose",
              brandName: "TESCO",
              defaultImageUrl:
                "https://digitalcontent.api.tesco.com/v2/media/ghs/bananas.jpeg?h=225&w=225",
              sellers: {
                results: [
                  {
                    price: { actual: 0.17, unitPrice: 1.1, unitOfMeasure: "kg" },
                    promotions: [
                      {
                        description: "Clubcard Price",
                        startDate: null,
                        endDate: null,
                        attributes: ["CLUBCARD_PRICING"],
                        price: { afterDiscount: 0.15, beforeDiscount: 0.17 },
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

describe("favourites", () => {
  it("sends GetFavourites and parses favourites.products[] into SearchResult[]", async () => {
    const { impl, calls } = stubFetch([{ body: FAVOURITES_BODY }]);
    const t = new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl });
    const { results } = await t.favourites({ limit: 50 });

    const op = calls[0]!.body[0];
    expect(op.operationName).toBe("GetFavourites");
    expect(op.extensions.mfeName).toBe("mfe-favourites");
    expect(op.variables).toMatchObject({ count: 50, page: 1, sortBy: "TAXONOMY" });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      sku: "111",
      tpnb: "11",
      title: "Tesco Semi Skimmed Milk",
      brand: "TESCO",
      imageUrl: "https://digitalcontent.api.tesco.com/v2/media/ghs/milk.jpeg?h=225&w=225",
      onOffer: false,
    });
    expect(results[0]!.price).toMatchObject({
      actual: 1.45,
      unitPrice: 0.64,
      unitOfMeasure: "litre",
    });
  });
});

describe("browseCategory", () => {
  it("sends GetCategoryProducts and parses category.results[].node into SearchResult[]", async () => {
    const { impl, calls } = stubFetch([{ body: CATEGORY_BODY }]);
    const t = new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl });
    const { results } = await t.browseCategory("b;RnJlc2ggRm9vZA==", { limit: 24 });

    const op = calls[0]!.body[0];
    expect(op.operationName).toBe("GetCategoryProducts");
    expect(op.extensions.mfeName).toBe("mfe-plp");
    expect(op.variables).toMatchObject({ facet: "b;RnJlc2ggRm9vZA==", count: 24, page: 1 });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      sku: "222",
      tpnb: "22",
      title: "Tesco Bananas Loose",
      imageUrl: "https://digitalcontent.api.tesco.com/v2/media/ghs/bananas.jpeg?h=225&w=225",
      onOffer: true,
    });
    expect(results[0]!.promotions[0]).toMatchObject({
      priceAfterDiscount: 0.15,
      priceBeforeDiscount: 0.17,
    });
  });
});
