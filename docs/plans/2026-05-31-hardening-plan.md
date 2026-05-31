# basketeer 0.1 Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the actionable findings from two code reviews so basketeer reads as polished OSS: MCP auth refresh + tool annotations, HTTP-401 refresh, CLI input validation, honest portability/Akamai wording, a `prepare` script, and CI + Biome.

**Architecture:** Localized, mostly-mechanical changes per file plus three new files (`biome.json`, `tsconfig.typecheck.json`, `.github/workflows/ci.yml`). Two items get real unit tests (401→refresh, numeric validation); the rest are verified by build, the new CI, and reading the diff. No behavioral restructuring.

**Tech Stack:** TypeScript (ESM/NodeNext), vitest, commander, `@modelcontextprotocol/sdk`, Playwright (optional peer), Biome, GitHub Actions.

**Spec:** [docs/design/2026-05-31-hardening-design.md](../design/2026-05-31-hardening-design.md)

**Branch:** master (direct — the user authorized this; repo not pushed). **Baseline:** `npm test` → 46 green. Commit-message trailer on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## Task 1: MCP auth can refresh

**Files:** Modify `src/mcp-server.ts`

- [ ] **Step 1: give the MCP client a refresh-capable backend**

At the top of `src/mcp-server.ts`, add the import (match the path the CLI uses):
```ts
import { BrowserAuthBackend } from "./auth/browser/playwright.js";
```
Change the client construction from:
```ts
const client = await Basketeer.resume({ store: new FileTokenStore() });
```
to:
```ts
const client = await Basketeer.resume({
  store: new FileTokenStore(),
  authBackend: new BrowserAuthBackend(),
});
```

- [ ] **Step 2: build + test**

Run: `npm run build && npm test`
Expected: PASS (46). No behavior change for reads; authed tools can now refresh.

- [ ] **Step 3: commit**

```bash
git add src/mcp-server.ts
git commit -m "fix(mcp): resume with BrowserAuthBackend so authed tools can refresh past ~1h

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: HTTP 401 triggers refresh

**Files:** Modify `src/graphql.ts`; Test: `tests/regressions.test.ts`

Context: `GraphQLTransport.execute()` already refreshes-and-retries once when `isUnauthorized(errors)` is true, but only GraphQL `errors[]` reach it. A raw HTTP 401 (often non-JSON) currently becomes a `GraphQLRequestError` and bypasses refresh. First read `src/graphql.ts` (the `execute`, `post`, and `isUnauthorized` definitions) and `tests/regressions.test.ts` / `tests/client.test.ts` to see the existing auth-refresh test pattern (a stub `fetchImpl` plus an `authBackend` whose `refresh` resolves).

- [ ] **Step 1: write the failing test** (append to `tests/regressions.test.ts`, following the existing auth-refresh test there)

```ts
it("refreshes once on a raw HTTP 401 and retries", async () => {
  let calls = 0;
  let refreshed = 0;
  const impl = (async () => {
    calls++;
    if (calls === 1) {
      return new Response("Unauthorized", { status: 401 }); // raw, non-JSON
    }
    return new Response(JSON.stringify([{ data: { product: PRODUCT_NODE } }]), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const backend = {
    login: async () => SESSION,
    refresh: async () => { refreshed++; return SESSION; },
  };
  const t = new Basketeer({ session: SESSION, authBackend: backend, throttleMs: 0, fetchImpl: impl });

  await t.getProduct("123");
  expect(refreshed).toBe(1);
  expect(calls).toBe(2);
});
```
(Reuse whatever `SESSION` and a minimal product node the file already defines; if `PRODUCT_NODE` doesn't exist, inline the minimal `{ tpnc: "123", ... }` shape the product parser needs, matching the existing product test.)

- [ ] **Step 2: run it — verify it fails**

Run: `npx vitest run tests/regressions.test.ts -t "raw HTTP 401"`
Expected: FAIL — the 401 currently throws `GraphQLRequestError`/`AuthExpiredError` without retrying (refreshed stays 0, or it throws).

- [ ] **Step 3: implement in `src/graphql.ts`**

In `post()`, right after `const text = await res.text();` and before the `403` block, add:
```ts
    if (res.status === 401) {
      // Raw HTTP 401 (often non-JSON). Surface as unauthorized so execute() refreshes + retries.
      return { errors: [{ message: "HTTP 401 Unauthorized", status: 401 }] };
    }
```
Then extend `isUnauthorized(errors)` so it also matches a status-401 / unauthorized error. Add this clause to whatever it currently checks (keep the existing GraphQL-extension checks):
```ts
  return errors.some((e) => {
    const o = e as { status?: unknown; message?: unknown };
    if (o.status === 401) return true;
    if (typeof o.message === "string" && /unauthor|401/i.test(o.message)) return true;
    // ...existing checks (e.g. extensions.code UNAUTHENTICATED) remain...
    return /* existing predicate */ false;
  });
```
(Preserve the existing predicate logic; only add the status/message clause above it.)

- [ ] **Step 4: run the tests — verify they pass**

Run: `npx vitest run tests/regressions.test.ts`
Expected: PASS (new test + all existing). Then `npm test` → full suite green.

- [ ] **Step 5: commit**

```bash
git add src/graphql.ts tests/regressions.test.ts
git commit -m "fix(transport): treat HTTP 401 as unauthorized so it triggers refresh+retry

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: MCP tool annotations

**Files:** Modify `src/mcp-server.ts`

Context: the MCP SDK's `server.tool(name, description, paramsSchema, annotations, cb)` accepts an annotations object between the schema and the callback. Add it to every tool. (If the installed SDK version's `tool()` overload differs, use the object/config form it supports — verify against `node_modules/@modelcontextprotocol/sdk` types; the annotation keys are `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`.)

- [ ] **Step 1: annotate read tools** — add `{ readOnlyHint: true }` as the annotations arg to: `basketeer_search`, `basketeer_product`, `basketeer_favourites`, `basketeer_basket_get`, `basketeer_slots_list`, `basketeer_orders_list`, `basketeer_nutrition`, `basketeer_search_by_nutrition`.

Example (search):
```ts
server.tool(
  "basketeer_search",
  "Search the Tesco grocery catalogue. Returns matching products with SKU, title, price, and any offers.",
  { query: z.string().describe("Search terms, e.g. 'semi skimmed milk'."), limit: z.number().int().positive().optional() },
  { readOnlyHint: true },
  ({ query, limit }) => run(() => client.search(query, { limit })),
);
```

- [ ] **Step 2: annotate mutating tools** — add `{ readOnlyHint: false, destructiveHint: true }` to: `basketeer_basket_set`, `basketeer_basket_remove`, `basketeer_orders_cancel`, `basketeer_checkout`. (`basketeer_reorder_last` mutates the basket too → `{ readOnlyHint: false, destructiveHint: false, idempotentHint: false }`.)

- [ ] **Step 3: build**

Run: `npm run build`
Expected: PASS. (No test — verify by reading each registration has the right hint.)

- [ ] **Step 4: commit**

```bash
git add src/mcp-server.ts
git commit -m "feat(mcp): add readOnly/destructive tool annotations for agent safety

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: CLI numeric input validation

**Files:** Modify `src/cli.ts`; Test: `tests/cli.test.ts` (new)

Context: `Number()`/`parseFloat`/`parseInt` let `NaN`/negatives through; `JSON.stringify(NaN)` becomes `null` in GraphQL variables. Add validating parsers and use them. `src/cli.ts` guards its `parseAsync` behind an `isMain` check, so importing it for tests is safe.

- [ ] **Step 1: write the failing test** (`tests/cli.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { nonNegativeInt, nonNegativeNumber } from "../src/cli.js";
import { InvalidArgumentError } from "commander";

describe("cli numeric parsers", () => {
  it("nonNegativeInt accepts valid, rejects junk/negative", () => {
    expect(nonNegativeInt("10")).toBe(10);
    expect(() => nonNegativeInt("abc")).toThrow(InvalidArgumentError);
    expect(() => nonNegativeInt("-1")).toThrow(InvalidArgumentError);
    expect(() => nonNegativeInt("NaN")).toThrow(InvalidArgumentError);
    expect(() => nonNegativeInt("1.5")).toThrow(InvalidArgumentError);
  });
  it("nonNegativeNumber accepts decimals, rejects junk/negative", () => {
    expect(nonNegativeNumber("8.5")).toBe(8.5);
    expect(() => nonNegativeNumber("-2")).toThrow(InvalidArgumentError);
    expect(() => nonNegativeNumber("abc")).toThrow(InvalidArgumentError);
  });
});
```

- [ ] **Step 2: run it — verify it fails**

Run: `npx vitest run tests/cli.test.ts`
Expected: FAIL — parsers not exported.

- [ ] **Step 3: implement in `src/cli.ts`**

Add the import (commander is already imported; add the named export):
```ts
import { Command, InvalidArgumentError } from "commander";
```
Add and export the two parsers near the top (after `emit`):
```ts
/** commander parser: a non-negative integer, else a usage error. */
export function nonNegativeInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError("must be a non-negative integer");
  return n;
}
/** commander parser: a non-negative number (decimals allowed), else a usage error. */
export function nonNegativeNumber(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new InvalidArgumentError("must be a non-negative number");
  return n;
}
```
Then use them:
- `search`: change `--limit` option to use `nonNegativeInt` (`.option("--limit <n>", "max results", nonNegativeInt, 10)`), `--hydrate` to `nonNegativeInt`, `--min-protein`/`--max-sugar` to `nonNegativeNumber`. Update the action to read `opts.limit` as the already-parsed number (drop the `Number(opts.limit)` casts).
- `favourites`: `--limit` → `nonNegativeInt`.
- `basket add` / `basket set`: parse the `<qty>` argument with `nonNegativeInt` — commander argument parsers attach via `.argument("<qty>", "desc", nonNegativeInt)` or validate inside the action; use whichever matches the existing argument style, and drop `Number(qty)`.

- [ ] **Step 4: run the tests — verify they pass**

Run: `npx vitest run tests/cli.test.ts` then `npm test`
Expected: PASS (full suite green).

- [ ] **Step 5: manual smoke**

Run: `npm run build && node dist/cli.js search milk --limit -1 ; echo "exit=$?"`
Expected: a usage error on stderr and non-zero exit (not a silent `null`).

- [ ] **Step 6: commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "fix(cli): validate numeric args (reject NaN/negative) for limits and quantities

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Honest portability wording

**Files:** Modify `README.md`

- [ ] **Step 1: reword the Portable bullet.** Find the `## Why basketeer` bullet that reads:
> - **Portable.** Runs anywhere `fetch` runs: Node, Bun, Deno, serverless, Electron. Just 3 runtime deps; the browser is an optional peer.

Replace with:
> - **Portable.** Runs on Node, Bun, Deno, and Node-compatible serverless/edge runtimes. Just 3 runtime deps; the browser is an optional peer.

Also scan the README for any other "anywhere `fetch` runs" / browser-portability phrasing and align it (e.g. the "How it works" / hero lines). Keep wording crisp, minimal em-dashes.

- [ ] **Step 2: commit**

```bash
git add README.md
git commit -m "docs: scope portability claim to Node-compatible runtimes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Neutral Akamai wording + de-pitch comments

**Files:** Modify `src/auth/browser/playwright.ts` (and any other `src/` file with marketing-tone comments)

- [ ] **Step 1: reword the bravado comments in `src/auth/browser/playwright.ts`.** Read the file. Reword comments that frame the shim as defeating "Akamai's automation tells" into neutral mechanics, e.g.:
> Use the system Chrome channel and a persistent profile so the session presents as an ordinary browser. Set `navigator.webdriver` to match a normal (non-automated) Chrome.

Keep the actual code unchanged.

- [ ] **Step 2: light de-pitch sweep.** `grep -rniE "defeat|bravado|magic|killer|genuinely|crush|unbeatable|secret sauce" src` and review any source comments that sell rather than explain; reword the few offenders to describe mechanics. Do NOT churn the whole codebase — only clear marketing-tone comments. (README/docs stay persuasive; this is source-comment tone only.)

- [ ] **Step 3: build + commit**

Run: `npm run build` (Expected: PASS — comments only.)
```bash
git add src/
git commit -m "docs: neutral wording for browser-automation comments

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `prepare` script for source installs

**Files:** Modify `package.json`

- [ ] **Step 1: add the script.** In the `scripts` block, add:
```json
    "prepare": "npm run build",
```
Keep `files` as `["dist", "README.md", "LICENSE"]` and `prepublishOnly` unchanged. (`prepare` runs on `npm install` from git and before publish, so `dist/` exists for `git`-based installs.)

- [ ] **Step 2: verify it doesn't break a normal install**

Run: `npm run prepare` (Expected: a clean build to `dist/`.) Then `npm pack --dry-run` (Expected: tarball still contains only `dist/`, `README.md`, `LICENSE`.)

- [ ] **Step 3: commit**

```bash
git add package.json
git commit -m "build: add prepare script so git installs build dist

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Biome (lint + format) + typecheck

**Files:** Create `biome.json`, `tsconfig.typecheck.json`; Modify `package.json`

- [ ] **Step 1: add Biome.** Run: `npm install -D @biomejs/biome` (this records it in devDependencies).

- [ ] **Step 2: create `biome.json`** matching the codebase style (2-space indent, double quotes, semicolons, trailing commas) with a lenient lint ruleset so existing code passes without mass rewrites:
```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "files": { "ignore": ["dist", "node_modules", "coverage"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "javascript": { "formatter": { "quoteStyle": "double", "semicolons": "always", "trailingCommas": "all" } },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": { "noExplicitAny": "off" },
      "style": { "noNonNullAssertion": "off", "noParameterAssign": "off" }
    }
  }
}
```
(Pin the `$schema` version to the installed Biome version.)

- [ ] **Step 3: create `tsconfig.typecheck.json`** that type-checks tests + examples (the build `tsconfig.json` excludes them):
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src", "tests", "examples"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: add scripts to `package.json`:**
```json
    "lint": "biome check .",
    "format": "biome format --write .",
    "typecheck": "tsc -p tsconfig.typecheck.json",
```
(If a `typecheck` script already exists, replace it with the line above.)

- [ ] **Step 5: run and fix genuine issues**

Run: `npm run lint`. Fix real errors Biome reports. If a rule forces large, low-value churn across the codebase, turn that specific rule `"off"` in `biome.json` (record why in a brief comment in the PR/commit message) rather than rewriting working code. Re-run until `npm run lint` exits 0.
Run: `npm run typecheck`. Fix any type errors it surfaces in `tests/`/`examples/` (these were previously unchecked). Re-run until clean.
Run: `npm test` (Expected: still 47+ green.)

- [ ] **Step 6: commit**

```bash
git add package.json package-lock.json biome.json tsconfig.typecheck.json src tests examples
git commit -m "build: add Biome lint/format and full typecheck (incl tests/examples)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: GitHub Actions CI + badge

**Files:** Create `.github/workflows/ci.yml`; Modify `README.md`

- [ ] **Step 1: create `.github/workflows/ci.yml`:**
```yaml
name: CI
on:
  push:
    branches: [master, main]
  pull_request:
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18, 20]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test
```

- [ ] **Step 2: add a CI badge to the README** hero badge row (after the `tests` badge). Use the repo slug `tobyandrews1985/basketeer`:
```markdown
[![CI](https://github.com/tobyandrews1985/basketeer/actions/workflows/ci.yml/badge.svg)](https://github.com/tobyandrews1985/basketeer/actions/workflows/ci.yml)
```
(The badge resolves once the repo is pushed and CI runs; harmless before then.)

- [ ] **Step 3: validate the workflow locally** by running its steps:

Run: `npm ci && npm run build && npm run typecheck && npm run lint && npm test`
Expected: all PASS (this is exactly what CI will run).

- [ ] **Step 4: commit**

```bash
git add .github/workflows/ci.yml README.md
git commit -m "ci: add GitHub Actions workflow (build, typecheck, lint, test) + badge

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review (completed by plan author)

- **Spec coverage:** every spec item maps to a task — #1→T1, #2→T2, #3→T3, #4→T4, #5→T5, #6+#9→T6, #7→T7, #8→T8+T9. ✓
- **Placeholder scan:** no TBD/TODO. The two "match the existing pattern" notes (T2 test SESSION/product node; T3 SDK `tool()` overload) point at concrete in-repo references, not vague gaps — TDD tests and the build pin the behavior.
- **Type/name consistency:** `nonNegativeInt`/`nonNegativeNumber` used identically in T4 test + impl + CLI options; `isUnauthorized` extension in T2 keeps the existing predicate; tool names in T3 match the registered names.
- **Ordering keeps the build green:** each task builds and tests green on its own; T8's typecheck/lint run after all source changes land.
- **Known soft spot:** T8 Biome tuning is necessarily adaptive (can't predict every finding) — the rule is "fix real errors, disable churn-forcing rules, never rewrite working code to satisfy a stylistic rule."
