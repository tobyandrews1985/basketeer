// tests/nutrition.test.ts

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Product } from "../src/models.js";
import { filterByNutrition, parseNutrition } from "../src/nutrition.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n: string) =>
  JSON.parse(readFileSync(join(here, "fixtures/nutrition", n), "utf8"));

describe("parseNutrition", () => {
  it("normalizes the Oatly drink (per 100ml, split energy, micros)", () => {
    const n = parseNutrition(fixture("oatly-barista.json"))!;
    expect(n.basis).toBe("per_100ml");
    expect(n.macros).toMatchObject({
      energyKj: 257,
      energyKcal: 61,
      fat: 3.0,
      saturates: 0.3,
      carbs: 7.1,
      sugars: 3.4,
      fibre: 0.8,
      protein: 1.1,
      salt: 0.1,
    });
    expect(n.micros).toContainEqual({
      name: "Vitamin B12",
      amount: 0.38,
      unit: "µg",
      nrvPercent: 15,
    });
    expect(n.micros).toContainEqual({ name: "Calcium", amount: 120, unit: "mg", nrvPercent: 15 });
    expect(n.micros).toHaveLength(5);
  });

  it("normalizes the chicken (per 100g, inline energy, no micros, value2 columns)", () => {
    const n = parseNutrition(fixture("chicken-breast.json"))!;
    expect(n.basis).toBe("per_100g");
    expect(n.macros).toMatchObject({
      energyKj: 486,
      energyKcal: 115,
      fat: 3.3,
      saturates: 0.8,
      carbs: 0,
      sugars: 0,
      fibre: 0,
      protein: 21.5,
      salt: 0.18,
    });
    expect(n.micros).toHaveLength(0);
  });

  it("returns null for empty/invalid input", () => {
    expect(parseNutrition(fixture("empty.json"))).toBeNull();
    expect(parseNutrition(null as unknown as unknown[])).toBeNull();
  });

  it("preserves the raw rows", () => {
    const rows = fixture("oatly-barista.json");
    expect(parseNutrition(rows)!.raw).toEqual(rows);
  });

  it("buckets edge macro labels and parses comma decimals (edge-labels fixture)", () => {
    const n = parseNutrition(fixture("edge-labels.json"))!;
    expect(n.macros.salt).toBe(0.5);
    expect(n.macros.carbs).toBe(12.5);
    expect(n.macros.protein).toBe(1.5);
    // those labels must not leak into micros
    const microNames = n.micros.map((m) => m.name);
    expect(microNames).not.toContain("Salt equivalent");
    expect(microNames).not.toContain("Total Carbohydrate");
  });
});

type Basis = "per_100g" | "per_100ml";

function product(
  sku: string,
  basis: Basis | null,
  macros: Partial<Record<string, number>>,
): Product {
  const nutrition =
    basis === null
      ? null
      : {
          basis,
          micros: [],
          raw: [],
          macros: {
            energyKcal: null,
            energyKj: null,
            protein: null,
            fat: null,
            saturates: null,
            carbs: null,
            sugars: null,
            fibre: null,
            salt: null,
            ...macros,
          },
        };
  return {
    sku,
    tpnb: sku,
    title: sku,
    brand: null,
    price: null,
    onOffer: null,
    promotions: [],
    packSize: null,
    nutrition,
    macros: nutrition?.macros ?? null,
    raw: {},
  } as unknown as Product;
}

describe("filterByNutrition", () => {
  const items = [
    product("a", "per_100g", { protein: 25, sugars: 1 }),
    product("b", "per_100g", { protein: 10, sugars: 9 }),
    product("c", "per_100g", { protein: 30, sugars: 0 }),
    product("d", null, {}), // no nutrition
  ];

  it("drops products with no nutrition when filtering", () => {
    const out = filterByNutrition(items, { where: { protein: { min: 0 } } });
    expect(out.map((p) => p.sku)).not.toContain("d");
  });

  it("applies min/max ranges", () => {
    const out = filterByNutrition(items, { where: { protein: { min: 20 }, sugars: { max: 2 } } });
    expect(out.map((p) => p.sku).sort()).toEqual(["a", "c"]);
  });

  it("sorts descending, missing last", () => {
    const out = filterByNutrition(items, { sort: { by: "protein", dir: "desc" } });
    expect(out.map((p) => p.sku)).toEqual(["c", "a", "b"]); // d dropped (sort references nutrition)
  });

  it("returns [] without throwing when no product has nutrition", () => {
    const noNut = [product("x", null, {})];
    expect(() => filterByNutrition(noNut, { where: { protein: { min: 0 } } })).not.toThrow();
    expect(filterByNutrition(noNut, { where: { protein: { min: 0 } } })).toEqual([]);
  });

  it("drops basis-mismatched products, keeping the first/majority basis", () => {
    const mixed = [
      product("g1", "per_100g", { protein: 25 }),
      product("g2", "per_100g", { protein: 30 }),
      product("ml1", "per_100ml", { protein: 28 }), // mismatched basis — must be dropped
    ];
    const out = filterByNutrition(mixed, { where: { protein: { min: 0 } } });
    expect(out.map((p) => p.sku).sort()).toEqual(["g1", "g2"]);
  });
});
