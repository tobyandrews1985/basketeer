# Design: Normalized nutrition + nutrition-filtered search

**Date:** 2026-05-31 · **Status:** approved, ready for implementation plan
**Component of:** basketeer (TypeScript SDK for a personal Tesco account)

## Summary

Tesco's product endpoint already returns an on-pack nutrition table, and basketeer
already fetches it (`nutrition { name value1 value2 value3 }`) but stores it raw and
unused (`Product.nutrition: unknown[]`). This feature **normalizes** those rows into a
typed model (macros + micros), **exposes** it across the SDK, CLI, and MCP server, and
adds **nutrition-filtered search** — find/rank products by their nutritional values.

This is a strong differentiator: real per-SKU macros *and* micros, free on anonymous
reads, usable for meal planning, macro tracking, and agent-driven shopping.

## Goals (v1)

1. Normalize the raw nutrition rows into a typed `Nutrition` model (macros + structured micros).
2. Expose normalized nutrition on `Product`, the CLI, and the MCP server.
3. Nutrition-filtered search: filter/rank products by nutritional values ("filter-within-search").

## Non-goals

- **Catalogue-wide nutrition discovery** ("highest-protein snack in all of Tesco"). Not feasible
  on the live API — search is keyword/category only, with no server-side nutrition filter, and
  nutrition is only on the product-detail fetch. Out of scope; would need a pre-built catalogue index.
- Per-serving as a first-class filter axis (captured opportunistically, but filtering is per-100 only).

## Decisions (resolved during brainstorming)

| Decision | Choice |
| --- | --- |
| v1 scope | Normalize + expose **and** filter-within-search |
| Schema richness | **Typed macros + structured micros** (numeric, filterable) |
| Search architecture | **Layered**: pure `filterByNutrition` primitive + `searchByNutrition` convenience wrapper |
| Products lacking nutrition when filtering | **Dropped** |
| `Product.nutrition` type change (`unknown[]` → `Nutrition \| null`) | Accepted (v0.1.0, unpublished) |
| Default hydration cap | `hydrate = 20` |

## Data model (`src/models.ts`)

```ts
export type NutritionBasis = "per_100g" | "per_100ml" | "per_serving" | "unknown";

export interface Macros {
  energyKcal: number | null;
  energyKj: number | null;
  protein: number | null;     // grams
  fat: number | null;         // grams
  saturates: number | null;   // grams
  carbs: number | null;       // grams
  sugars: number | null;      // grams
  fibre: number | null;       // grams
  salt: number | null;        // grams
}

export interface Micronutrient {
  name: string;               // "Vitamin B12"
  amount: number | null;      // 0.38
  unit: string | null;        // "µg", "mg"
  nrvPercent: number | null;  // 15  (% of Nutrient Reference Value)
}

export interface Nutrition {
  basis: NutritionBasis;      // what `macros` is measured against
  servingSize: string | null; // e.g. "250ml", if a per-serving column is present
  macros: Macros;
  micros: Micronutrient[];
  perServing: Macros | null;  // best-effort, if a per-serving column exists
  raw: unknown[];             // original rows — escape hatch
}
```

`Product.nutrition` changes from `unknown[]` to `Nutrition | null`. A convenience field
`product.macros` (populated by the parser, since `Product` is a plain object not a class)
mirrors `nutrition?.macros ?? null`.

## Components

### 1. Normalizer — `src/nutrition.ts` (new module, pure, no I/O)

`parseNutrition(rows: unknown[]): Nutrition | null`

Must handle the inconsistencies observed in real data:
- **Basis** from the header row: `"per 100 ml:"` → `per_100ml`, `"Per 100g"` → `per_100g`, else `unknown`.
- **Energy**, two observed shapes: inline `"486kJ / 115kcal"`, and split across rows
  (`"257 kJ/"` then a following `"-"` row holding `"61 kcal"`). Extract both `energyKj` and `energyKcal`.
- **Macro label aliases**: `Fat`; `Saturates` / `of which saturates`; `Carbohydrate` /
  `Available Carbohydrate`; `Sugars` / `of which sugars` / `sugars`; `Fibre`; `Protein`; `Salt`.
- **Value parsing**: `"3.0 g"` → `3.0`; `"0.10 g"` → `0.10`; strip footnote markers (`"3.4 g*"` → `3.4`).
- **Micros**: any row that is not a known macro, header, or footnote → parse
  `"1.1 µg (22%**)"` → `{ name, amount: 1.1, unit: "µg", nrvPercent: 22 }`.
- **Skip** footnote/legend rows: name starting with `*`, value `"-"`, `"of which"` with no value,
  `"As sold"`, `"Reference intake…"`, `"**Of the Nutrient Reference Value…"`.
- **Per-serving**: if `value2`/`value3` form a per-serving column (header indicates), parse into
  `perServing`; otherwise `null`.

**Error handling:** never throws. Any unparseable field → `null`. Returns `null` only when `rows`
is empty / not an array. `raw` always retains the original rows. (Matches the codebase's defensive,
null-safe parser philosophy.)

### 2. Filter primitive — `src/nutrition.ts` (pure)

```ts
export interface Range { min?: number; max?: number; }
export interface NutritionFilter {
  energyKcal?: Range; protein?: Range; fat?: Range; saturates?: Range;
  carbs?: Range; sugars?: Range; fibre?: Range; salt?: Range;
  micro?: { name: string; min?: number; max?: number }[];
}
export interface NutritionSort { by: keyof Macros | string /* micro name */; dir?: "asc" | "desc"; }

export function filterByNutrition(
  products: Product[],
  opts: { where?: NutritionFilter; sort?: NutritionSort; basis?: NutritionBasis }
): Product[];
```

- Products with `nutrition === null` are **dropped** when `where` (or a nutrition `sort`) is present.
- Comparison is like-for-like on basis. If `opts.basis` is given, products of a different basis are
  dropped (can't compare per-100g to per-100ml). If not given, default to the basis of the first
  product that has nutrition, and drop products of a different basis. Mismatches are surfaced to
  callers via the count delta (no silent mixing).
- Sort: missing values sort last regardless of direction.

### 3. Convenience search — `src/client.ts`

```ts
searchByNutrition(query: string, opts?: {
  where?: NutritionFilter;
  sort?: NutritionSort;
  hydrate?: number;   // max results to fetch nutrition for (default 20)
  limit?: number;     // final result cap
}): Promise<{ results: Product[]; hydrated: number; skipped: number }>;
```

Flow: `search(query)` → take first `hydrate` results → `getProduct(sku)` for each (serial; relies on
the existing 1 req/s transport throttle) → `filterByNutrition(hydrated, { where, sort })` → top `limit`.
Returns the hydrated/skipped counts so the cost is **explicit and reported** — no silent caps.

### 4. CLI — `src/cli.ts`

- `basketeer nutrition <sku>` → normalized `Nutrition` JSON to stdout.
- `basketeer search <query>` gains: `--min-protein <g>`, `--max-sugar <g>`, `--sort <field>`,
  `--hydrate <n>`. When any nutrition flag is present, route through `searchByNutrition`; otherwise
  the plain `search`. (The SDK supports the full `NutritionFilter`; the CLI exposes the common subset in v1.)

### 5. MCP — `src/mcp-server.ts`

- `basketeer_nutrition` (sku → normalized nutrition).
- `basketeer_search_by_nutrition` (query + where + sort + hydrate → ranked products with macros).
- `basketeer_product` already returns nutrition — now normalized.

## Data flow

```
parseProduct(raw)      ──►  product.nutrition = parseNutrition(raw.nutrition rows)
search(q)              ──►  SearchPage (no nutrition; results are lean)
searchByNutrition(q)   ──►  search(q) ─► getProduct×N (throttled) ─► filterByNutrition ─► ranked Product[]
filterByNutrition(ps)  ──►  pure: drop no-nutrition, apply where, sort  (no network)
```

## Testing strategy (`tests/`)

- **Fixtures** `tests/fixtures/nutrition/*.json`: raw `nutrition` rows captured from ~6 real products
  spanning observed shapes — a drink (per-100ml, micros, split energy), a meat (per-100g, value2 columns),
  a cereal/multipack, a ready meal (per-serving column), and a product with no nutrition. Captured live
  (anonymous) during implementation.
- **`tests/nutrition.test.ts`**: `parseNutrition` against every fixture (basis, energy reassembly, macro
  aliases, micro parsing, footnote skipping, null-safety); `filterByNutrition` (drop-no-nutrition,
  ranges, sort, basis-mismatch).
- **Client**: `searchByNutrition` with a stubbed client (mock `search` + `getProduct`) — hydration cap,
  reported counts, filtering end-to-end.

## Module boundaries / files changed

| File | Change |
| --- | --- |
| `src/nutrition.ts` | **new** — `parseNutrition`, `filterByNutrition`, label maps, value parsing (pure, no I/O) |
| `src/models.ts` | add `NutritionBasis`, `Macros`, `Micronutrient`, `Nutrition`, `Range`, `NutritionFilter`, `NutritionSort`; change `Product.nutrition` |
| `src/parsers.ts` | `parseProduct` calls `parseNutrition` to populate `product.nutrition`; add `product.macros` getter |
| `src/client.ts` | add `searchByNutrition` |
| `src/cli.ts` | `nutrition` command + nutrition flags on `search` |
| `src/mcp-server.ts` | `basketeer_nutrition`, `basketeer_search_by_nutrition` tools |
| `src/index.ts` | export new public types + `filterByNutrition` |
| `tests/` | fixtures + `nutrition.test.ts` + searchByNutrition test |
| `README.md` / `docs/api.md` | document the feature + the honest search constraint |

## Honest constraints (to document)

- **Search-by-nutrition is bounded**, not catalogue-wide: a keyword search plus a capped number of
  hydration fetches (default 20, ≈20s at 1 req/s). It filters within a keyword search, not all of Tesco.
- **Basis matters**: per-100g and per-100ml are not directly comparable; filtering compares like-for-like
  and drops mismatches rather than mixing them.
- **Parsing is best-effort** over an inconsistent on-pack table. Unparseable values are `null`; the raw
  rows are always preserved on `nutrition.raw`.
