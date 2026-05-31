# Design: basketeer 0.1 hardening pass

**Date:** 2026-05-31 · **Status:** approved · **Branch:** master (direct, no PR — repo not pushed)

## Summary

Two independent reviews judged basketeer a "strong 0.1 with a solid, tasteful core" that needs a hardening pass before it reads as polished OSS. This spec collects the actionable findings into one cohesive pass. (Two findings — the `searchByNutrition` hydration cap and the inert `servingSize`/`perServing` fields — were already fixed during the nutrition merge and are out of scope here.)

## Decisions (resolved during brainstorming)

| Area | Choice |
| --- | --- |
| MCP auth refresh | Give the MCP server a `BrowserAuthBackend` so it can refresh past the ~1h token (desktop host). |
| Agent-safety boundary | MCP tool **annotations only** (`readOnlyHint`/`destructiveHint`); no write-gate. |
| CI + lint/format | **Biome** + GitHub Actions. |
| Packaging | Keep `files` lean; add a `prepare` script. |
| Portability claim | Reword the README to "Node-compatible runtimes" — no code refactor. |

## Items

### 1. MCP auth can refresh (P1) — `src/mcp-server.ts`
Currently `Basketeer.resume({ store: new FileTokenStore() })` has no `authBackend`, so authed tools die when the ~1h `OAuth.AccessToken` expires. **Change:** resume with `authBackend: new BrowserAuthBackend()` (import from `./auth/browser/playwright.js`, as the CLI does). On expiry the existing refresh path runs a headed Chrome refresh. Document in the README that MCP refresh needs a desktop/display; headless hosts keep the ~1h ceiling and must re-`login`.

### 2. HTTP 401 triggers refresh (P2) — `src/graphql.ts`
`execute()` already refreshes-and-retries once when `isUnauthorized(errors)` is true, but only GraphQL `errors[]` reach that check. A plain/non-JSON HTTP 401 currently becomes a `GraphQLRequestError` and bypasses refresh. **Change:** in `post()`, when `res.status === 401`, return a synthetic unauthorized error envelope (e.g. `{ errors: [{ message: "HTTP 401", status: 401 }] }`) and extend `isUnauthorized()` to match a `status === 401` (or 401/unauthorized in the message). `execute()`'s existing one-refresh-retry then fires. **Test:** a stub returning 401 on the first call and data on the second asserts one refresh occurred and the call succeeded; a persistent 401 throws `AuthExpiredError`.

### 3. MCP tool annotations (P1) — `src/mcp-server.ts`
Add MCP annotations to every `server.tool(...)` via the SDK's annotations slot:
- `readOnlyHint: true` — `basketeer_search`, `_product`, `_favourites`, `_basket_get`, `_slots_list`, `_orders_list`, `_nutrition`, `_search_by_nutrition`.
- `destructiveHint: true` (and `readOnlyHint: false`) — `_basket_set`, `_basket_remove`, `_orders_cancel`, `_checkout`.
Annotations only — no behavioral gate. Verified by build + reading the registrations.

### 4. CLI numeric validation (P2) — `src/cli.ts`
`Number()`/`parseFloat`/`parseInt` currently let `NaN`/negative/absurd values through (and `JSON.stringify(NaN)` → `null` in GraphQL variables). **Change:** a small validating parser that throws commander's `InvalidArgumentError` on non-finite or negative input, used for `--limit`, `--hydrate`, and basket `qty` (and any other numeric arg). **Test:** unit-test the parser rejects `"abc"`, `"-1"`, `"NaN"` and accepts valid values. (The parser is a pure function — export it for testing or test via a thin wrapper.)

### 5. Portability claim (P2) — `README.md`
The "Portable. Runs anywhere `fetch` runs" bullet overclaims: the code uses `node:crypto`, `Buffer`, and `process.env`. **Change:** reword to "Runs on Node, Bun, Deno, and Node-compatible serverless/edge runtimes" (drop the browser/"anywhere fetch" implication). Wording only; no refactor toward browser-purity in this pass.

### 6. Akamai comment wording (P2) — `src/auth/browser/playwright.ts`
Comments describing the shim as defeating "Akamai's automation tells" and patching `navigator.webdriver` are a legal/reputational magnet for an OSS repo. **Change:** reword to neutral mechanics (e.g. "Use the real Chrome channel and a persistent profile so the session looks like a normal browser; align `navigator.webdriver`."). Keep the behavior; change only the prose.

### 7. Packaging: `prepare` script (P2) — `package.json`
`main`/`exports`/`bin` point at `dist/`, but `dist/` is gitignored, so `npm install github:user/repo` ships no build. **Change:** add `"prepare": "npm run build"` so source installs build `dist` automatically. Keep `files` = `["dist", "README.md", "LICENSE"]` (npm rewrites relative doc/image links to GitHub). `prepublishOnly` stays.

### 8. CI + lint/format (P3) — new files + `package.json`
- Add `@biomejs/biome` (devDep) and `biome.json` (sane defaults; format + a lint ruleset that fits the existing style — do not mass-rewrite the codebase; fix only what Biome flags as errors, downgrade noisy stylistic rules).
- Scripts: `"lint": "biome check ."`, `"format": "biome format --write ."`, and a `"typecheck"` that type-checks **including** `tests/` and `examples/` (a `tsconfig.typecheck.json` that extends the base but clears the `exclude` and sets `noEmit`).
- `.github/workflows/ci.yml`: on push + PR, Node 18/20 matrix, `npm ci`, `npm run build`, `npm test`, `npm run lint`, `npm run typecheck`.
- Add a CI status badge to the README.

### 9. De-pitch source comments (QA)
A light sweep of comments that "sell" rather than explain mechanics (the Akamai ones in #6, plus any similar marketing-tone comments in `src/`). Keep it surgical — reword the few offenders, don't churn the whole codebase. README/docs may stay persuasive; source comments explain how, not why-it's-great.

## Testing & verification

- **Unit-tested:** #2 (401→refresh), #4 (numeric validation).
- **Build/CI/manual:** #1, #3, #5, #6, #7, #8, #9 — verified by `npm run build`, the new CI pipeline green, and reading the diffs. After #8, `npm run lint` and `npm run typecheck` must pass.
- No behavioral restructuring; all changes localized per file. New files: `biome.json`, `tsconfig.typecheck.json`, `.github/workflows/ci.yml`.

## Out of scope (this pass)

- Making the data plane genuinely browser/worker-clean (removing `node:crypto`/`Buffer`). That's a real refactor; #5 only corrects the claim.
- A write-gate or dry-run/confirm for destructive MCP tools (annotations only, per decision).
- Trimming the public API surface / session shape (noted by review as "exposes a bit much"); revisit if it becomes a concern.
