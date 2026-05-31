<div align="center">

# basketeer

**A typed, pure-HTTP TypeScript SDK for your own Tesco grocery account.**

Search, build a basket, book a delivery slot, place & amend orders — over plain `fetch`. A real browser is needed only for the two moments that genuinely require a human: the occasional **sign-in** and the **final payment**. Everything in between runs anywhere — Node, Bun, Deno, Lambda, a Convex action, Electron, a worker.

[![npm](https://img.shields.io/npm/v/basketeer.svg)](https://www.npmjs.com/package/basketeer)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![node >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

*“[garth](https://github.com/matin/garth) for Tesco” — solve the auth once, then hand you a clean client.*

</div>

> [!IMPORTANT]
> **Not affiliated with, endorsed by, or connected to Tesco.** This is an unofficial, reverse-engineered client for automating **your own** account, in the spirit of personal interoperability. It can break at any time if Tesco changes their API. Use it for your own shopping, at your own risk, within Tesco's terms — not for resale, scraping at scale, or operating accounts that aren't yours. See [Ethics & usage](#ethics--usage).

```bash
npm install basketeer
```

## Quick start

### Anonymous reads — zero setup

Product search and lookup need nothing but the public API key:

```ts
import { Basketeer } from "basketeer";

const client = new Basketeer();

const { results } = await client.search("wholemeal bread", { limit: 10 });
const product = await client.getProduct(results[0]!.sku);
console.log(product.title, product.price.actual); // "Tesco Wholemeal Bread 800G" 0.75
```

### Authenticated — sign in once, then pure HTTP

Auth is minted by a real browser once (Tesco's login sits behind Akamai bot defenses). After that, every call is `fetch`.

```bash
npx playwright install chromium   # once, if the system 'chrome' channel isn't found
```

```ts
import { Basketeer, FileTokenStore } from "basketeer";
import { BrowserAuthBackend } from "basketeer/auth/browser/playwright";

const store = new FileTokenStore();            // ~/.basketeer/session.json
const authBackend = new BrowserAuthBackend();  // opens a real Chrome to sign in

// First run: a Chrome window opens, you sign in once, the session is harvested.
const first = new Basketeer({ store, authBackend });
await first.login();

// Any later process: resume + transparent refresh. Pure HTTP from here.
const client = await Basketeer.resume({ store, authBackend });

// 1. Find things — your usuals, then search to fill gaps.
const usuals = (await client.favourites({ limit: 50 })).results;
const milk = (await client.search("semi skimmed milk", { limit: 5 })).results[0]!;

// 2. Build the basket.
await client.basket.add(milk.sku, 2);     // add 2 (increments the line)
await client.basket.set(usuals[0]!.sku, 1); // set an exact quantity (0 removes)
const basket = await client.basket.get();

// 3. Book a delivery slot.
const slots = await client.slots.list();             // today..+6 days
const free = slots.find((s) => s.status === "Available");
if (free) await client.slots.book(free.id);          // held until reservationExpiry

// 4. Hand off to the browser for payment — the SDK STOPS here, on purpose.
const { url } = await client.checkout();
console.log("Finish payment in a browser:", url);   // 3-D Secure is browser-bound
```

## Capabilities

| Area | API | Auth | Notes |
| --- | --- | --- | --- |
| Product | `getProduct(sku)` → `Product` | anon | `sku` is the Tesco `tpnc`. Throws `NotFoundError`. |
| Search | `search(q, { limit?, page? })` → `SearchPage` | anon | `{ results, page, pageSize, hasMore }`. |
| Browse | `browseCategory(facet, opts)` → `SearchPage` | anon | Build `facet` with `categoryFacet("Fresh Food")`. |
| Favourites | `favourites(opts)` → `SearchPage` | authed | "My usuals". |
| Basket | `basket.get / add / set / remove / update` → `Basket` | authed | `add` increments; `set` is exact (0 removes). |
| Delivery slots | `slots.list({ start?, end?, type? })` → `Slot[]` | authed | Default window today..+6 days. |
| Collection slots | `slots.listCollection(opts)` → `Slot[]` | authed | Click-and-collect. |
| Book / release | `slots.book(id)` / `slots.release(id)` → `BookedSlot` | authed | Held until `reservationExpiry`. |
| Orders | `orders.list(opts)` → `Order[]` | authed | Upcoming orders + amend window. |
| Amend | `orders.amend(no)` → `Amendment` | authed | Scoped handle: `.set / .remove / .discard`. |
| Cancel | `orders.cancel(no)` | authed | Before the cutoff. |
| Reorder | `orders.lastFulfilled()` → `Order \| null` | authed | Last delivered shop. |
| Checkout | `checkout()` → `{ basket, url }` | authed | **Stops at the payment URL — never pays.** |

## How it works

Tesco has no public API, but its website talks to a GraphQL gateway at `xapi.tesco.com`. basketeer speaks that protocol directly:

- **The data plane is pure HTTP.** Search, product, basket, slots, and orders are GraphQL operations over plain `fetch` — stateless, no browser, throttled to a polite 1 req/s, with a hard stop on `429`/`403` (no retry-storms). Reads need only the public `x-apikey`.
- **A real browser is needed only for auth.** Sign-in is guarded by Akamai (TLS/JA3 fingerprinting + a JS challenge) that only a genuine browser satisfies. So `BrowserAuthBackend` drives a real Chrome to sign you in once and harvests the session (an `OAuth.AccessToken` bearer + cookies). The access token lasts ~1 hour and is refreshed via the same browser path; the underlying session lasts ~30 days.
- **Payment is deliberately out of scope.** Placing/paying for an order goes through a separate, CSRF-protected checkout app and **3-D Secure** card authentication — browser-bound by design and PCI/fraud-sensitive. `checkout()` fills the basket, books the slot, and returns the URL where **you** finish payment in a browser. basketeer never pays.

The browser, when needed at all, lives **only** behind the `AuthBackend` seam — never on the product/basket/slot/order path.

## Auth — a swappable seam, host nothing

The library hard-depends on no browser; it just needs a `Session`. **You** decide where (and whether) a browser runs:

| Your host | Browser runs… | Use |
| --- | --- | --- |
| Desktop / Electron / CLI / self-hosted | the user's machine | `BrowserAuthBackend` (local Playwright) |
| Long-running container | real Chrome under Xvfb (no monitor) | `BrowserAuthBackend` + Xvfb |
| Serverless / cloud agent | a hosted browser on a **residential** IP | a custom `AuthBackend`, or bring your own session |
| You harvest the session yourself | wherever you like | `sessionFromCookies(cookies)` |

```ts
import { Basketeer, sessionFromCookies } from "basketeer";

// Got cookies from your own browser anywhere? Hand them straight in:
const session = sessionFromCookies(myCookieList); // {name,value}[] → Session
const client = new Basketeer({ session });        // reads + writes, pure HTTP
```

Implement your own backend with the two-method `AuthBackend` (`login`, `refresh`) and three-method `TokenStore` (`load`, `save`, `clear`). `FileTokenStore` and `MemoryTokenStore` ship in the box.

> **Serverless note.** A serverless function can't hold a browser, and Tesco's Akamai blocks the sign-in from **datacenter** IPs — so a hosted browser needs a **residential** egress. Off-the-shelf managed-browser proxies (e.g. Browserbase's) are also commonly blocked by the proxy provider for supermarket domains. The dependable pattern is a browser on a residential connection you control (a home server / Pi / the user's device), with the pure-HTTP data plane running anywhere.

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

A stdio MCP server ships as the `basketeer-mcp` bin, exposing tools (`basketeer_search`, `basketeer_basket_set`, `basketeer_slots_list`, `basketeer_orders_list`, `basketeer_checkout`, …) so Claude Desktop or any MCP client can shop. `basketeer_checkout` returns the payment URL for the human — there is no "pay" tool.

```jsonc
// claude_desktop_config.json — run `basketeer login` once first so it has a session.
{
  "mcpServers": {
    "basketeer": { "command": "npx", "args": ["-y", "-p", "basketeer", "basketeer-mcp"] }
  }
}
```

## CLI

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

## Errors

Everything thrown is a `BasketeerError` subclass:

- `NotFoundError` — `getProduct` for an unknown SKU.
- `ApiKeyError` — the public `x-apikey` was rejected (`403 "Invalid Client"`). It rotates ~monthly; set `TESCO_API_KEY` or pass `{ apiKey }`. Never retryable.
- `RateLimitedError` — `429`/`403`. The client **stops** rather than retry-storming; back off.
- `AuthExpiredError` — the session couldn't be refreshed; re-authenticate.
- `LineRejectedError` — Tesco rejected a basket-line update (never assume a write succeeded).
- `GraphQLRequestError` — a non-auth GraphQL error (full detail on `.errors`; the message is scrubbed).

## Examples

Runnable scripts in [`examples/`](examples/): [`lookup.ts`](examples/lookup.ts) (anonymous), [`login.ts`](examples/login.ts), [`shop-flow.ts`](examples/shop-flow.ts) (search → basket → slot → checkout handoff), [`orders.ts`](examples/orders.ts), [`bring-your-own-auth.ts`](examples/bring-your-own-auth.ts), and [`browserbase.ts`](examples/browserbase.ts) (a serverless hosted-browser recipe).

## Ethics & usage

Personal-account interoperability automation — your account, your data, the same posture as [garth](https://github.com/matin/garth). The client defaults to **1 request/second**, single concurrency, and stops on `429`/`403`. Please keep it that way. **Not** for resale, bulk scraping, or multi-account operation. This project is not affiliated with Tesco; "Tesco" is a trademark of its owner and is used here only to describe interoperability.

## Development

```bash
npm install
npm test          # vitest unit + regression + smoke suite
npm run build     # clean build to dist/
npm run example:lookup
```

PRs welcome — keep code readable and minimal, add a test for any behaviour change, and never commit a session or API key.

## License

[MIT](./LICENSE) © Toby Andrews
