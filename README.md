<div align="center">

# basketeer

**A typed, pure-HTTP TypeScript SDK for your own Tesco grocery account.**

One typed core, with a CLI and an MCP server on top, so your code, your terminal, or an AI agent can run the weekly shop. Everything but sign-in and payment is plain `fetch`.

<sub>The CLI prints JSON. Here <code>basketeer search "oat milk"</code> is piped to <code>jq '.results[0]'</code> to show one result of many. Real, live, no login.</sub>

<img src="docs/media/demo.gif" alt="basketeer searching Tesco from the CLI — live results, no browser" width="760">

[![npm](https://img.shields.io/npm/v/basketeer.svg)](https://www.npmjs.com/package/basketeer)
[![tests](https://img.shields.io/badge/tests-33%20passing-brightgreen.svg)](tests/)
[![runtime deps](https://img.shields.io/badge/runtime%20deps-3-blue.svg)](package.json)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![node >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

</div>

> [!IMPORTANT]
> **Not affiliated with, endorsed by, or connected to Tesco.** This is an unofficial, reverse-engineered client for automating **your own** account, in the spirit of personal interoperability. It can break if Tesco changes their API. Use it for your own shopping, at your own risk, within Tesco's terms. Not for resale, scraping at scale, or operating accounts that aren't yours. See [Ethics & usage](#ethics--usage).

## Why basketeer

Tesco has no public API. The tools that exist scrape the DOM and shatter on the next site redesign, and none of them let an AI agent shop for you. basketeer talks to Tesco's GraphQL gateway directly:

- **Robust.** Pure-HTTP GraphQL, not DOM scraping. A cosmetic site redesign won't break it.
- **Complete.** Book, amend, cancel, and reorder a delivered shop. The full order lifecycle, not just "add to basket."
- **Typed.** A clean, fully-typed client you import. The CLI and MCP server are built on it.
- **Portable.** Runs anywhere `fetch` runs: Node, Bun, Deno, serverless, Electron. Just 3 runtime deps; the browser is an optional peer.
- **Safe.** `checkout()` stops at the payment URL. A human finishes 3-D Secure in a browser, by design.
- **Tested.** 33 tests across the data plane and its parsers.

## Quick start

```bash
npm install basketeer
```

### Anonymous reads — zero setup

Product search and lookup need nothing but the public API key:

```ts
import { Basketeer } from "basketeer";

const client = new Basketeer();

const { results } = await client.search("wholemeal bread", { limit: 10 });
const product = await client.getProduct(results[0]!.sku);

console.log(product.title, product.price.actual);
// => "Tesco Wholemeal Bread 800G" 0.75
```

### Authenticated — sign in once, then pure HTTP

A real browser mints the session once (Tesco's login sits behind Akamai bot defenses). Every call after that is `fetch`.

```bash
npx playwright install chromium   # once, if the system 'chrome' channel isn't found
```

```ts
import { Basketeer, FileTokenStore } from "basketeer";
import { BrowserAuthBackend } from "basketeer/auth/browser/playwright";

const store = new FileTokenStore();            // ~/.basketeer/session.json
const authBackend = new BrowserAuthBackend();  // opens a real Chrome to sign in

// First run: a Chrome window opens, you sign in once, the session is harvested.
await new Basketeer({ store, authBackend }).login();

// Any later process: resume + transparent refresh. Pure HTTP from here.
const client = await Basketeer.resume({ store, authBackend });

// 1. Find things: your usuals, then search to fill gaps.
const usuals = (await client.favourites({ limit: 50 })).results;
const milk = (await client.search("semi skimmed milk", { limit: 5 })).results[0]!;

// 2. Build the basket.
await client.basket.add(milk.sku, 2);        // add 2 (increments the line)
await client.basket.set(usuals[0]!.sku, 1);  // set an exact quantity (0 removes)

// 3. Book a delivery slot.
const slots = await client.slots.list();              // today..+6 days
const free = slots.find((s) => s.status === "Available");
if (free) await client.slots.book(free.id);           // held until reservationExpiry

// 4. Hand off to the browser for payment. The SDK stops here, on purpose.
const { url } = await client.checkout();
console.log("Finish payment in a browser:", url);
```

## Capabilities

The full grocery lifecycle, typed end to end:

- **Catalogue** — `search`, `getProduct`, `browseCategory`, `favourites` (reads are anonymous)
- **Basket** — `add`, `set`, `remove`, `get`
- **Slots** — delivery and collection: `list` / `book` / `release`
- **Orders** — `list`, `amend`, `cancel`, `lastFulfilled` (reorder)
- **Checkout** — `checkout()` returns the payment URL; it never pays

→ Full reference (signatures, return types, the error catalogue, and where the browser runs): **[docs/api.md](docs/api.md)**

## How it works

Tesco's website talks to a GraphQL gateway at `xapi.tesco.com`. basketeer speaks that protocol directly.

- **The data plane is pure HTTP.** Search, product, basket, slots, and orders are GraphQL operations over plain `fetch`. Stateless, no browser, throttled to a polite 1 req/s, with a hard stop on `429`/`403` (no retry-storms). Reads need only the public `x-apikey`.
- **A browser is needed only for auth.** Sign-in is guarded by Akamai (TLS fingerprinting plus a JS challenge) that only a genuine browser satisfies. `BrowserAuthBackend` drives a real Chrome to sign you in once and harvests the session (an `OAuth.AccessToken` bearer plus cookies). The access token lasts ~1 hour and refreshes via the same browser path; the underlying session lasts ~30 days.
- **Payment is deliberately out of scope.** Paying for an order goes through a separate, CSRF-protected checkout app and 3-D Secure card authentication. That is browser-bound and fraud-sensitive by nature. `checkout()` fills the basket, books the slot, and returns the URL where **you** finish payment. basketeer never pays.

## Auth — you choose where the browser runs

The library hard-depends on no browser. It just needs a `Session`. Run the browser on the user's machine (`BrowserAuthBackend` + local Playwright), under Xvfb in a long-running container, on a residential hosted browser for serverless, or skip it entirely and hand in cookies you harvested yourself:

```ts
import { Basketeer, sessionFromCookies } from "basketeer";

// Got cookies from your own browser anywhere? Hand them straight in:
const session = sessionFromCookies(myCookieList); // {name,value}[] => Session
const client = new Basketeer({ session });        // reads + writes, pure HTTP
```

Implement your own backend with the two-method `AuthBackend` (`login`, `refresh`) and three-method `TokenStore` (`load`, `save`, `clear`). `FileTokenStore` and `MemoryTokenStore` ship in the box. The full host matrix is in [docs/api.md](docs/api.md#auth-where-the-browser-runs).

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

A stdio MCP server ships as the `basketeer-mcp` bin, exposing tools (`basketeer_search`, `basketeer_basket_set`, `basketeer_slots_list`, `basketeer_orders_list`, `basketeer_checkout`, …) so Claude Desktop or any MCP client can shop. `basketeer_checkout` returns the payment URL for the human. There is no "pay" tool.

```jsonc
// claude_desktop_config.json — run `basketeer login` once first so it has a session.
{
  "mcpServers": {
    "basketeer": { "command": "npx", "args": ["-y", "-p", "basketeer", "basketeer-mcp"] }
  }
}
```

## CLI

![The basketeer CLI command palette](docs/media/cli.png)

The `basketeer` bin prints JSON to stdout, coded errors to stderr. Install globally for the bare command, or prefix with `npx -p basketeer`:

```bash
basketeer login                      # one-time browser sign-in
basketeer search "oat milk" --limit 5
basketeer product 254656543
basketeer favourites
basketeer basket add 258114107 1     # increment;  basket set <sku> <qty> for exact
basketeer slots                      # --collection for click-and-collect
basketeer orders list
basketeer checkout                   # prints the payment URL; you finish in a browser
```

## Examples

Runnable scripts in [`examples/`](examples/): [`lookup.ts`](examples/lookup.ts) (anonymous), [`login.ts`](examples/login.ts), [`shop-flow.ts`](examples/shop-flow.ts) (search → basket → slot → checkout handoff), [`orders.ts`](examples/orders.ts), and [`bring-your-own-auth.ts`](examples/bring-your-own-auth.ts).

## Ethics & usage

Personal-account interoperability automation: your account, your data. The client defaults to **1 request/second**, single concurrency, and stops on `429`/`403`. Please keep it that way. Not for resale, bulk scraping, or multi-account operation. This project is not affiliated with Tesco; "Tesco" is a trademark of its owner and is used here only to describe interoperability.

## Development

```bash
npm install
npm test          # 33 tests: vitest unit + regression + smoke
npm run build     # clean build to dist/
npm run example:lookup
```

PRs welcome. Keep code readable and minimal, add a test for any behaviour change, and never commit a session or API key.

## License

[MIT](./LICENSE) © Toby Andrews
