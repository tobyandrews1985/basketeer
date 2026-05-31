// src/nutrition.ts — pure nutrition normalization + filtering. No I/O.
import type {
  Macros, Micronutrient, Nutrition, NutritionBasis,
} from "./models.js";

const emptyMacros = (): Macros => ({
  energyKcal: null, energyKj: null, protein: null, fat: null,
  saturates: null, carbs: null, sugars: null, fibre: null, salt: null,
});

/** First number in a string: "3.0 g" -> 3.0, "21.5g" -> 21.5, "3.4 g*" -> 3.4. */
function num(s: string | null): number | null {
  if (!s) return null;
  const m = s.match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

/** Unit right after the number: "1.1 µg (22%)" -> "µg", "3.0 g" -> "g". */
function unitOf(s: string): string | null {
  const m = s.match(/-?\d+(?:\.\d+)?\s*([A-Za-zµμ]+)/);
  return m ? (m[1] ?? null) : null;
}

/** NRV percent in parens: "(22%**)" -> 22. */
function nrvOf(s: string): number | null {
  const m = s.match(/\((\d+(?:\.\d+)?)\s*%/);
  return m ? parseFloat(m[1] ?? "0") : null;
}

function basisFromHeader(v: string): NutritionBasis {
  const t = v.toLowerCase();
  if (t.includes("100 ml") || t.includes("100ml")) return "per_100ml";
  if (t.includes("100 g") || t.includes("100g")) return "per_100g";
  if (t.includes("serving")) return "per_serving";
  return "unknown";
}

const MACRO_LABELS: Record<string, keyof Macros> = {
  "fat": "fat",
  "saturates": "saturates",
  "of which saturates": "saturates",
  "carbohydrate": "carbs",
  "available carbohydrate": "carbs",
  "sugars": "sugars",
  "of which sugars": "sugars",
  "fibre": "fibre",
  "protein": "protein",
  "salt": "salt",
};

function isFootnote(name: string, value: string | null): boolean {
  const n = name.trim();
  if (n.startsWith("*")) return true;
  if (/^of which$/i.test(n)) return true;
  if (/^as sold$/i.test(n)) return true;
  if (/reference intake|nutrient reference value/i.test(n)) return true;
  const known = !!MACRO_LABELS[n.toLowerCase()] || /^energy/i.test(n);
  if (!known && (value === "-" || value === null || value === "")) return true;
  return false;
}

export function parseNutrition(rows: unknown[]): Nutrition | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const macros = emptyMacros();
  const micros: Micronutrient[] = [];
  let basis: NutritionBasis = "unknown";
  let expectKcalNext = false;

  for (const r of rows) {
    const row = (r ?? {}) as { name?: unknown; value1?: unknown };
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const value1 = typeof row.value1 === "string" ? row.value1.trim() : null;
    if (!name) continue;

    // Energy split across two rows: "257 kJ/" then a row whose value holds the kcal.
    if (expectKcalNext) {
      expectKcalNext = false;
      if (value1 && /kcal/i.test(value1)) {
        macros.energyKcal = num(value1.match(/(\d+(?:\.\d+)?)\s*kcal/i)?.[0] ?? null);
        continue;
      }
      // not a kcal continuation — fall through and process normally
    }

    // Header row → basis
    if (/typical values/i.test(name) || (value1 && /per\s*100|per\s*serving/i.test(value1))) {
      if (value1) basis = basisFromHeader(value1);
      continue;
    }

    // Energy (inline "486kJ / 115kcal" or split "257 kJ/")
    if (/^energy/i.test(name)) {
      if (value1) {
        const kj = value1.match(/(\d+(?:\.\d+)?)\s*kj/i);
        const kcal = value1.match(/(\d+(?:\.\d+)?)\s*kcal/i);
        if (kj) macros.energyKj = parseFloat(kj[1] ?? "0");
        if (kcal) macros.energyKcal = parseFloat(kcal[1] ?? "0");
        if (kj && !kcal) expectKcalNext = true;
      }
      continue;
    }

    if (isFootnote(name, value1)) continue;

    const key = MACRO_LABELS[name.toLowerCase()];
    if (key) {
      macros[key] = num(value1);
      continue;
    }

    // Anything else with a value is a micronutrient.
    if (value1) {
      micros.push({ name, amount: num(value1), unit: unitOf(value1), nrvPercent: nrvOf(value1) });
    }
  }

  return { basis, servingSize: null, macros, micros, perServing: null, raw: rows };
}

import type { Product, NutritionFilter, NutritionSort, MacroFilterKey, Range } from "./models.js";

const MACRO_FILTER_KEYS: MacroFilterKey[] =
  ["energyKcal", "protein", "fat", "saturates", "carbs", "sugars", "fibre", "salt"];

/** Access a product's nutrition safely regardless of the current Product.nutrition type. */
function pn(p: Product): Nutrition | null {
  return (p as unknown as { nutrition: Nutrition | null }).nutrition ?? null;
}

function inRange(v: number | null, r: Range | undefined): boolean {
  if (!r) return true;
  if (v == null) return false;
  if (r.min != null && v < r.min) return false;
  if (r.max != null && v > r.max) return false;
  return true;
}

function sortValue(p: Product, by: string): number | null {
  const n = pn(p);
  const m = n?.macros;
  if (m && by in m) return m[by as keyof typeof m];
  const micro = n?.micros.find((x: Micronutrient) => x.name.toLowerCase() === by.toLowerCase());
  return micro?.amount ?? null;
}

export function filterByNutrition(
  products: Product[],
  opts: { where?: NutritionFilter; sort?: NutritionSort; basis?: NutritionBasis } = {},
): Product[] {
  const { where, sort, basis } = opts;
  const usesNutrition = !!where || !!sort;

  let out = usesNutrition ? products.filter((p) => pn(p)) : [...products];

  if (usesNutrition) {
    const target = basis ?? pn(out.find((p) => pn(p))!)?.basis;
    if (target) out = out.filter((p) => pn(p)?.basis === target);
  }

  if (where) {
    out = out.filter((p) => {
      const n = pn(p)!;
      const m = n.macros;
      for (const k of MACRO_FILTER_KEYS) {
        if (where[k] && !inRange(m[k], where[k])) return false;
      }
      for (const mc of where.micro ?? []) {
        const found = n.micros.find((x: Micronutrient) => x.name.toLowerCase() === mc.name.toLowerCase());
        if (!inRange(found?.amount ?? null, { min: mc.min, max: mc.max })) return false;
      }
      return true;
    });
  }

  if (sort) {
    const dir = sort.dir === "asc" ? 1 : -1;
    out = [...out].sort((a, b) => {
      const av = sortValue(a, String(sort.by));
      const bv = sortValue(b, String(sort.by));
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * dir;
    });
  }

  return out;
}
