/**
 * Field projection for MCP search tools (issue #10).
 *
 * Agents pass `select`, an array of dot-notation paths, to keep only the
 * fields they need from each result — full search responses are token-heavy
 * for LLM loops. A path segment that lands on an array projects each element
 * (`promotions.description` keeps the description of every promotion).
 */

import type { Product, SearchResult } from "./models.js";

// Record<keyof T, true> so adding a model field without listing it here fails
// to compile — the valid-field lists can't drift from the interfaces.
const SEARCH_RESULT_KEYS: Record<keyof SearchResult, true> = {
  sku: true,
  tpnb: true,
  title: true,
  brand: true,
  imageUrl: true,
  price: true,
  available: true,
  onOffer: true,
  promotions: true,
  quantityRules: true,
};
export const SEARCH_RESULT_FIELDS: readonly string[] = Object.keys(SEARCH_RESULT_KEYS);

const PRODUCT_KEYS: Record<keyof Product, true> = {
  sku: true,
  tpnb: true,
  title: true,
  brand: true,
  imageUrl: true,
  price: true,
  available: true,
  packSize: true,
  promotions: true,
  nutrition: true,
  macros: true,
  raw: true,
  quantityRules: true,
};
export const PRODUCT_FIELDS: readonly string[] = Object.keys(PRODUCT_KEYS);

/** Nested keep-tree parsed from paths; `null` means "keep this whole subtree". */
type Tree = { [key: string]: Tree | null };

function buildTree(paths: readonly string[], validFields: readonly string[]): Tree {
  const root: Tree = {};
  for (const path of paths) {
    const segments = path.split(".");
    if (segments.some((s) => s === "")) {
      throw new RangeError(`select path "${path}" has an empty segment`);
    }
    const head = segments[0] ?? "";
    if (!validFields.includes(head)) {
      throw new RangeError(
        `unknown select field "${head}" — valid fields: ${validFields.join(", ")}`,
      );
    }
    let node = root;
    for (const [i, seg] of segments.entries()) {
      if (node[seg] === null) break; // an ancestor path already keeps everything here
      if (i === segments.length - 1) {
        node[seg] = null; // keep-all wins over any deeper paths seen earlier
      } else {
        node = node[seg] ??= {};
      }
    }
  }
  return root;
}

function apply(value: unknown, tree: Tree | null): unknown {
  if (tree === null) return value;
  if (Array.isArray(value)) return value.map((v) => apply(v, tree));
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, sub] of Object.entries(tree)) {
    if (key in value) out[key] = apply((value as Record<string, unknown>)[key], sub);
  }
  return out;
}

/**
 * Project each result down to `paths`. Throws `RangeError` on a path whose
 * first segment is not in `validFields` (so a mistyped field tells the agent
 * what is valid instead of silently returning empty objects); deeper segments
 * that don't exist are simply omitted.
 */
export function projectResults(
  results: readonly unknown[],
  paths: readonly string[],
  validFields: readonly string[],
): unknown[] {
  const tree = buildTree(paths, validFields);
  return results.map((r) => apply(r, tree));
}
