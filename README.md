<div align="center">

# basketeer

**A typed, pure-HTTP TypeScript SDK for your own Tesco grocery account, with on-pack nutrition normalized into typed data.**

Run your weekly shop from code, the terminal, or an AI agent. Everything but sign-in and payment is plain `fetch`, and products come back with their on-pack nutrition normalized into typed macros *and* micronutrients you can search and rank by.

<sub>Unofficial · not affiliated with Tesco · for automating your own account · MIT</sub>

<br>

<img src="https://raw.githubusercontent.com/tobyandrews1985/basketeer/main/docs/media/nutrition.gif" alt="basketeer filtering and ranking a live Tesco search by nutrition, then reading a product's micronutrients" width="760">

<sub>Filter and rank a live search by on-pack nutrition (protein ≥ 10g, sugar ≤ 7g), then read any product's full macros and micronutrients. Real data, no login.</sub>

<br><br>

<img src="https://raw.githubusercontent.com/tobyandrews1985/basketeer/main/docs/media/demo.gif" alt="basketeer searching Tesco from the CLI, live results, no browser" width="760">

<sub>Plain catalogue search is a one-liner: <code>basketeer search "oat milk"</code> piped to <code>jq</code>. Real, live, no login.</sub>

<br>

[![CI](https://github.com/tobyandrews1985/basketeer/actions/workflows/ci.yml/badge.svg)](https://github.com/tobyandrews1985/basketeer/actions/workflows/ci.yml)
[![tests](https://img.shields.io/badge/tests-75%20passing-brightgreen.svg)](tests/)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![node >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

</div>

## Why basketeer

Tesco has no public API, and the usual approach (scraping the DOM) shatters on the next site redesign, stops at titles and prices, and can't be driven by an AI agent. basketeer talks to Tesco's GraphQL gateway directly:

- **Nutritionally aware.** Where Tesco lists on-pack nutrition, basketeer normalizes it into typed macros *and* structured micronutrients, free on anonymous reads, and lets you filter and *rank* a search by them (`searchByNutrition`). A first-class API, not a scraped afterthought.
- **Robust.** Pure-HTTP GraphQL, not DOM scraping. A cosmetic site redesign won't break it.
- **Complete.** Book, amend, cancel, and reorder a delivered shop. The full order lifecycle, not just "add to basket."
- **Agent-ready.** A stdio MCP server lets Claude or any MCP client run the shop. Read-only and destructive tools are annotated, and checkout never pays.
- **Typed and lean.** One fully-typed client you import; the CLI and MCP server are built on it. The data path imports no third-party packages (the three runtime deps — commander, the MCP SDK, and zod — are pulled only by the CLI and MCP server). It is pure `fetch` with no Node-only APIs, so it runs on Node and Node-compatible runtimes.
- **Safe.** `checkout()` stops at the payment URL. A human finishes 3-D Secure in a browser, by design.
- **Tested.** 75 tests across the data plane and its parsers.

## Nutrition, the part nothing else has

When Tesco lists a product's on-pack nutrition, basketeer normalizes it into typed macros (energy, protein, fat, saturates, carbs, sugars, fibre, salt) and structured micronutrients (a named entry per vitamin and mineral, with amount, unit, and % of the Nutrient Reference Value). Free, on **anonymous reads** (`nutrition` is `null` when a product has no usable rows). And you can search *and rank* by it:

```bash
# "high-protein yogurt, >=10g protein, <=7g sugar, ranked by protein" — live, no login
basketeer search "high protein yogurt" --min-protein 10 --max-sugar 7 --sort protein
```

```ts
import { Basketeer } from "basketeer";

const client = new Basketeer(); // no auth needed for nutrition reads

const { results, hydrated, failed } = await client.searchByNutrition("high protein yogurt", {
  where: { protein: { min: 10 }, sugars: { max: 7 } },
  sort: { by: "protein", dir: "desc" },
});

results[0]?.macros;            // { energyKcal, protein, fat, saturates, carbs, sugars, fibre, salt }
results[0]?.nutrition?.micros; // [{ name: "Calcium", amount: 120, unit: "mg", nrvPercent: 15 }, ...]
```

> Nutrition-filtered search runs a keyword search, then fetches each candidate's nutrition (one throttled product call each, capped by `hydrate`, default 20) and filters locally. It filters *within* a search; it does not scan the whole catalogue. `hydrated`/`failed` report the exact cost.

---

> [!IMPORTANT]
> **Not affiliated with, endorsed by, or connected to Tesco.** This is an unofficial, reverse-engineered client for automating **your own** account, in the spirit of personal interoperability. It can break if Tesco changes their API. Use it for your own shopping, at your own risk, within Tesco's terms. Not for resale, scraping at scale, or operating accounts that aren't yours. See [Ethics & usage](#ethics--usage).

## Quick start

```bash
npm install basketeer
```

### Anonymous reads, zero setup

Catalogue search, product lookup, and nutrition need nothing but the public API key:

```ts
import { Basketeer } from "basketeer";

const client = new Basketeer();

const { results } = await client.search("wholemeal bread", { limit: 10 });
const top = results[0];
if (top) {
  const product = await client.getProduct(top.sku);
  console.log(product.title, product.price.actual);
  // => "Tesco Wholemeal Bread 800G" 0.75
}
```

### Authenticated, sign in once, then pure HTTP

Sign-in sits behind Akamai's bot defenses, so a real browser mints the session once. After that, the data plane is plain `fetch`; only a token refresh (about once an hour) briefly reopens the browser.

```bash
npm install basketeer playwright   # playwright is an optional peer dep, only used for sign-in
npx playwright install chrome      # the Chrome channel sign-in drives (skip if you already have Google Chrome)
```

```ts
import { Basketeer, FileTokenStore } from "basketeer";
import { BrowserAuthBackend } from "basketeer/auth/browser/playwright";

const store = new FileTokenStore();            // ~/.basketeer/session.json
const authBackend = new BrowserAuthBackend();  // drives your installed Google Chrome

// First run: a Chrome window opens, you sign in once, the session is harvested.
await new Basketeer({ store, authBackend }).login();

// Any later process: resume. Data calls are pure fetch; refresh reopens the browser.
const client = await Basketeer.resume({ store, authBackend });

// 1. Find things, then build the basket.
const milk = (await client.search("semi skimmed milk", { limit: 5 })).results[0];
if (milk) await client.basket.add(milk.sku, 2);     // add 2 (increments the line)

// Your "usuals" (needs auth). Set exact quantities for the first few:
const usuals = (await client.favourites({ limit: 50 })).results;
for (const item of usuals.slice(0, 3)) await client.basket.set(item.sku, 1); // 0 removes

// 2. Book a delivery slot.
const slots = await client.slots.list();              // today..+6 days
const free = slots.find((s) => s.status === "Available");
if (free) await client.slots.book(free.id);           // held until reservationExpiry

// 3. Hand off to the browser for payment. The SDK stops here, on purpose.
const { url } = await client.checkout();
console.log("Finish payment in a browser:", url);
```

## Capabilities

The full grocery lifecycle, typed end to end:

- **Nutrition** — typed macros and structured micros, normalized from a product's on-pack rows when present; filter and rank a search by nutrition (anonymous)
- **Catalogue** — `search`, `getProduct`, `browseCategory` (anonymous); `favourites` / "my usuals" (authed)
- **Product images** — `imageUrl` on every product/result; `resizeImageUrl(url, { width, height })` for thumbnails (anonymous)
- **Basket** — `add`, `set`, `remove`, `get`
- **Slots** — delivery and collection: `list` / `book` / `release`
- **Orders** — `list`, `amend`, `cancel`, `lastFulfilled` (reorder)
- **Checkout** — `checkout()` returns the payment URL; it never pays

→ Full reference (signatures, return types, the error catalogue, and where the browser runs): **[docs/api.md](https://github.com/tobyandrews1985/basketeer/blob/main/docs/api.md)**

## How it works

Tesco's website talks to a GraphQL gateway at `xapi.tesco.com`. basketeer speaks that protocol directly.

- **The data plane is pure HTTP.** Search, product, basket, slots, and orders are GraphQL operations over plain `fetch`. Stateless, no browser, throttled to a polite 1 req/s, with a hard stop on `429`/`403` (no retry-storms). Anonymous reads (search, product, browse, nutrition) need only the public `x-apikey`; `favourites`, basket, slots, and orders need a session.
- **A browser is needed only for auth.** Sign-in is guarded by Akamai (TLS fingerprinting plus a JS challenge) that only a genuine browser satisfies. `BrowserAuthBackend` drives your installed Google Chrome to sign you in once and harvests the session (an `OAuth.AccessToken` bearer plus cookies). The access token lasts about an hour and refreshes via the same browser path; the underlying session lasts about 30 days.
- **Payment is deliberately out of scope.** Paying goes through a separate, CSRF-protected checkout app and 3-D Secure card authentication. That is browser-bound and fraud-sensitive by nature. `checkout()` returns the current basket and the URL where **you** finish payment; you fill the basket and book a slot with the earlier calls, and `checkout()` itself only hands off. basketeer never pays.

## Auth, you choose where the browser runs

The library hard-depends on no browser. It just needs a `Session`. Run the browser on the user's machine (`BrowserAuthBackend` plus the optional `playwright` peer), under Xvfb in a long-running container, on a residential hosted browser for serverless, or skip it entirely and hand in cookies you harvested yourself:

```ts
import { Basketeer, sessionFromCookies } from "basketeer";

// Got cookies from your own browser anywhere? Hand them straight in:
const session = sessionFromCookies(myCookieList); // {name,value}[] => Session
const client = new Basketeer({ session });        // reads + writes, pure HTTP
```

Implement your own backend with the two-method `AuthBackend` (`login`, `refresh`) and three-method `TokenStore` (`load`, `save`, `clear`). `FileTokenStore` and `MemoryTokenStore` ship in the box. The full host matrix is in [docs/api.md](https://github.com/tobyandrews1985/basketeer/blob/main/docs/api.md#auth-where-the-browser-runs).

> **Serverless note.** A serverless function can't hold a browser, and Tesco's Akamai blocks sign-in from **datacenter** IPs, so a hosted browser needs a **residential** egress. Off-the-shelf managed-browser proxies (Browserbase and similar) are also commonly blocked for supermarket domains. The dependable pattern is a browser on a residential connection you control (a home server, a Pi, the user's device), with the pure-HTTP data plane running anywhere.

## Orders & amend

```ts
const orders = await client.orders.list();
for (const o of orders) console.log(o.orderNo, o.status, o.totalPrice, "amend until", o.amendExpiry);

// Amend returns a scoped handle; basket edits apply to THAT order.
const amendment = await client.orders.amend(orders[0]!.orderNo);
await amendment.remove("258114107");
await amendment.set("292632440", 1);
// ...then check out again to commit (pays any difference), or:
await amendment.discard(); // leave the order unchanged

client.amendingOrderNo;             // the order currently open for amendment, or null
await client.orders.cancel(orders[0]!.orderNo);

// "Reorder my usual shop":
const last = await client.orders.lastFulfilled();
for (const it of last?.items ?? []) await client.basket.set(it.productId!, it.quantity, it.unit ?? "pcs");
```

## MCP server (for AI agents)

A stdio MCP server ships as the `basketeer-mcp` bin, exposing tools (`basketeer_search`, `basketeer_search_by_nutrition`, `basketeer_nutrition`, `basketeer_basket_set`, `basketeer_slots_list`, `basketeer_orders_list`, `basketeer_checkout`, …) so Claude Desktop or any MCP client can shop. Read-only tools carry `readOnlyHint`; mutating ones carry `destructiveHint`, and `basketeer_orders_cancel` / `basketeer_checkout` take a two-step confirm token. `basketeer_checkout` returns the payment URL for the human. There is no "pay" tool. The search tools take an optional `select` — an array of dot-notation paths (e.g. `["sku", "title", "price.actual", "promotions.description"]`) that trims each result to just those fields, keeping token usage down in agent loops.

```jsonc
// claude_desktop_config.json — run `basketeer login` once first so it has a session.
{
  "mcpServers": {
    "basketeer": { "command": "npx", "args": ["-y", "-p", "basketeer", "basketeer-mcp"] }
  }
}
```

## CLI

![The basketeer CLI command palette](https://raw.githubusercontent.com/tobyandrews1985/basketeer/main/docs/media/cli.png)

The `basketeer` bin prints JSON to stdout, coded errors to stderr. Install globally for the bare command, or prefix with `npx -p basketeer`:

```bash
basketeer login                      # one-time browser sign-in
basketeer search "oat milk" --limit 5
basketeer search "high protein yogurt" --min-protein 10 --max-sugar 7 --sort protein
basketeer product 254656543
basketeer nutrition 292990463        # normalized macros + micros for a product
basketeer favourites
basketeer basket add 258114107 1     # increment;  basket set <sku> <qty> for exact
basketeer slots                      # --collection for click-and-collect
basketeer orders list
basketeer checkout                   # prints the payment URL; you finish in a browser
```

## Examples

Runnable scripts in [`examples/`](examples/): [`lookup.ts`](examples/lookup.ts) (anonymous), [`login.ts`](examples/login.ts), [`shop-flow.ts`](examples/shop-flow.ts) (search → basket → slot → checkout handoff), [`orders.ts`](examples/orders.ts), and [`bring-your-own-auth.ts`](examples/bring-your-own-auth.ts).

## Troubleshooting

Everything thrown is a `BasketeerError` subclass, so you can branch on the type. The common cases:

- **`ApiKeyError` (the public key was rejected).** The bundled `x-apikey` rotates roughly monthly. Set your own with the `TESCO_API_KEY` env var or `new Basketeer({ apiKey })`. Not retryable.
- **`AuthExpiredError` (session could not be refreshed).** Run `basketeer login` again. Headless hosts cannot refresh (Akamai blocks headless sign-in), so they hit the ~1h token ceiling and must re-login on a machine with a display.
- **`RateLimitedError` (`429`/`403`).** The client stops rather than retry-storm. Back off; it already throttles to 1 req/s by default.
- **`AuthExpiredError` on a `401`.** A single `401` triggers one transparent browser refresh and retry; a persistent `401` surfaces as `AuthExpiredError`.
- **"Chrome channel not found" at login.** `BrowserAuthBackend` drives the system Google Chrome (`chrome` channel). Install Chrome, or run `npx playwright install chrome`. Make sure the optional `playwright` peer is installed.

## Security & session storage

`FileTokenStore` writes `~/.basketeer/session.json` containing a bearer token and cookies in **plaintext**. Treat it like a password: keep its file permissions tight, never commit it, and clear it (`store.clear()`) on a shared machine. For ephemeral or server contexts use `MemoryTokenStore` or your own `TokenStore`, and keep the session out of logs.

## Known limitations

- **UK Tesco only.** Built against the UK groceries gateway; other regions are untested.
- **Pre-release (v0.1).** The public API may change between minor versions until 1.0.
- **Reverse-engineered.** No public contract from Tesco; an operation or the public key can change and break a call until updated.
- **Auth needs a real browser on a residential connection.** Datacenter IPs are blocked for sign-in; the pure-HTTP data plane runs anywhere.
- **Nutrition search is bounded**, not catalogue-wide: it filters within a keyword search, capped by `hydrate`.
- **Collection slots need a `locationUuid`** for the store you collect from.

## Ethics & usage

Personal-account interoperability automation: your account, your data. The client defaults to **1 request/second**, single concurrency, and stops on `429`/`403`. Please keep it that way. Not for resale, bulk scraping, or multi-account operation. This project is not affiliated with Tesco; "Tesco" is a trademark of its owner and is used here only to describe interoperability.

## Development

```bash
npm install
npm test          # 75 tests: vitest unit + regression + smoke
npm run build     # clean build to dist/
npm run example:lookup
```

PRs welcome. Keep code readable and minimal, add a test for any behaviour change, and never commit a session or API key.

## License

[MIT](./LICENSE) © Toby Andrews
