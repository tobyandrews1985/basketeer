# basketeer — API reference

The full surface. For the pitch, quick start, and how it works, see the [README](../README.md).

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
| Checkout | `checkout()` → `{ basket, url }` | authed | **Stops at the payment URL. Never pays.** |

## Auth: where the browser runs

The library hard-depends on no browser. It just needs a `Session`. You decide where, and whether, a browser runs:

| Your host | Browser runs… | Use |
| --- | --- | --- |
| Desktop / Electron / CLI / self-hosted | the user's machine | `BrowserAuthBackend` (local Playwright) |
| Long-running container | real Chrome under Xvfb (no monitor) | `BrowserAuthBackend` + Xvfb |
| Serverless / cloud agent | a hosted browser on a **residential** IP | a custom `AuthBackend`, or bring your own session |
| You harvest the session yourself | wherever you like | `sessionFromCookies(cookies)` |

Implement your own backend with the two-method `AuthBackend` (`login`, `refresh`) and three-method `TokenStore` (`load`, `save`, `clear`). `FileTokenStore` and `MemoryTokenStore` ship in the box.

> **Serverless note.** A serverless function can't hold a browser, and Tesco's Akamai blocks sign-in from **datacenter** IPs, so a hosted browser needs a **residential** egress. Off-the-shelf managed-browser proxies (Browserbase and similar) are also commonly blocked for supermarket domains. The dependable pattern is a browser on a residential connection you control (a home server, a Pi, the user's device), with the pure-HTTP data plane running anywhere.

## Errors

Everything thrown is a `BasketeerError` subclass:

- `NotFoundError` — `getProduct` for an unknown SKU.
- `ApiKeyError` — the public `x-apikey` was rejected (`403 "Invalid Client"`). It rotates ~monthly; set `TESCO_API_KEY` or pass `{ apiKey }`. Never retryable.
- `RateLimitedError` — `429`/`403`. The client stops rather than retry-storming; back off.
- `AuthExpiredError` — the session couldn't be refreshed; re-authenticate.
- `LineRejectedError` — Tesco rejected a basket-line update (never assume a write succeeded).
- `GraphQLRequestError` — a non-auth GraphQL error (full detail on `.errors`; the message is scrubbed).
