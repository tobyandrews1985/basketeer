import { describe, expect, it } from "vitest";
import { projectResults, SEARCH_RESULT_FIELDS } from "../src/select.js";

const salmon = {
  sku: "310127031",
  tpnb: "90008022",
  title: "Mowi 2 Scottish Salmon Fillets 230G",
  brand: "MOWI",
  imageUrl: null,
  price: { actual: 6.5, unitPrice: 28.26, unitOfMeasure: "kg" },
  onOffer: true,
  promotions: [
    {
      description: "£3.75 Clubcard Price",
      startDate: "2026-06-23T23:00:00Z",
      endDate: "2026-08-04T23:00:00Z",
      attributes: ["CLUBCARD_PRICING"],
      priceAfterDiscount: 6.5,
      priceBeforeDiscount: null,
    },
  ],
};

function projectOne(paths: string[]) {
  return projectResults([salmon], paths, SEARCH_RESULT_FIELDS)[0];
}

describe("projectResults", () => {
  it("keeps only the selected top-level fields", () => {
    expect(projectOne(["sku", "title"])).toEqual({
      sku: "310127031",
      title: "Mowi 2 Scottish Salmon Fillets 230G",
    });
  });

  it("keeps nested fields via dot paths", () => {
    expect(projectOne(["price.actual", "price.unitOfMeasure"])).toEqual({
      price: { actual: 6.5, unitOfMeasure: "kg" },
    });
  });

  it("projects into each element of an array", () => {
    expect(projectOne(["promotions.description"])).toEqual({
      promotions: [{ description: "£3.75 Clubcard Price" }],
    });
  });

  it("a whole-field path wins over a deeper one, in either order", () => {
    const whole = { price: salmon.price };
    expect(projectOne(["price", "price.actual"])).toEqual(whole);
    expect(projectOne(["price.actual", "price"])).toEqual(whole);
  });

  it("returns a primitive as-is when the path goes deeper than the data", () => {
    expect(projectOne(["sku.digits"])).toEqual({ sku: "310127031" });
  });

  it("silently omits a missing nested key", () => {
    expect(projectOne(["price.rrp"])).toEqual({ price: {} });
  });

  it("rejects an unknown top-level field, listing the valid ones", () => {
    expect(() => projectOne(["pricing.actual"])).toThrow(
      /unknown select field "pricing".*valid fields: .*price/,
    );
  });

  it("rejects a path with an empty segment", () => {
    expect(() => projectOne(["price..actual"])).toThrow(RangeError);
  });
});
