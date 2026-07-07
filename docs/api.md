# basketeer — API reference

The full surface. For the pitch, quick start, and how it works, see the [README](../README.md).

## Capabilities

| Area | API | Auth | Notes |
| --- | --- | --- | --- |
| Product | `getProduct(sku)` → `Product` | anon | `sku` is the Tesco `tpnc`. Throws `NotFoundError`. |
| Search | `search(q, { limit?, page? })` → `SearchPage` | anon | `{ results, page, pageSize, hasMore }`. |
| Browse | `browseCategory(facet, opts)` → `SearchPage` | anon | Build `facet` with `categoryFacet("Fresh Food")`. |
| Favourites | `favourites(opts)` → `SearchPage` | authed | "My usuals". |
| Nutrition search | `searchByNutrition(q, opts)` → `{ results, hydrated, failed, hasMore }` | anon | Keyword search then bounded hydration + filter. See [Nutrition](#nutrition). |
| Basket | `basket.get / add / set / remove` → `Basket` | authed | `add` increments; `set` is exact (0 removes). |
| Basket (batch) | `basket.update(items, orderId?)` → `BasketUpdateResult` | authed | `{ basket, rejected, unavailable }` — line failures reported, not thrown. |
| Delivery slots | `slots.list({ start?, end?, type? })` → `Slot[]` | authed | Default window today..+6 days. |
| Collection slots | `slots.listCollection(opts)` → `Slot[]` | authed | Click-and-collect. |
| Book / release | `slots.book(id)` / `slots.release(id)` → `BookedSlot` | authed | Held until `reservationExpiry`. |
| Orders | `orders.list(opts)` → `Order[]` | authed | Upcoming orders + amend window. |
| Amend | `orders.amend(no)` → `Amendment` | authed | Scoped handle: `.set / .remove / .discard`. |
| Cancel | `orders.cancel(no)` | authed | Before the cutoff. |
| Reorder | `orders.lastFulfilled()` → `Order \| null` | authed | Last delivered shop. |
| Checkout | `checkout()` → `{ basket, url }` | authed | **Stops at the payment URL. Never pays.** |

## Product images

`Product` and `SearchResult` include `imageUrl: string | null`, populated from Tesco's `defaultImageUrl` when it is present. Search-like APIs (`search`, `browseCategory`, and `favourites`) return this field without requiring a separate product lookup.

`Product`, `SearchResult`, and `BasketLine` also include `available: boolean | null` (Tesco's `isForSale`). Availability is **slot-specific**: anonymous reads report the optimistic national answer, while reads on a session bound to a booked slot report the real per-store answer — the same SKU can come back `available: true` anonymously and `false` once a slot is attached. `basket.add`/`set` reject unavailable lines with `ItemUnavailableError` (see Errors); the batch `basket.update` rolls them back too, but reports them on `BasketUpdateResult.unavailable` instead of throwing, because a batch can partly succeed.

```ts
import { Basketeer, resizeImageUrl } from "basketeer";

const client = new Basketeer();
const { results } = await client.search("red peppers", { limit: 1 });
const thumbnail = resizeImageUrl(results[0]?.imageUrl ?? null, { width: 135, height: 135 });
```

Tesco image URLs usually include `h` and `w` query parameters. `resizeImageUrl(url, { width, height })` returns a copy with those dimensions set, preserves unrelated query parameters, returns `null` for a null input, and throws `RangeError` for non-positive or non-integer dimensions.

## Nutrition

### Types

| Type | Fields | Notes |
| --- | --- | --- |
| `Nutrition` | `basis`, `macros`, `micros`, `raw` | `null` if Tesco returned no rows or they were unparseable. |
| `Macros` | `energyKcal`, `energyKj`, `protein`, `fat`, `saturates`, `carbs`, `sugars`, `fibre`, `salt` | All `number \| null` (g or kcal/kJ). |
| `Micronutrient` | `name`, `amount`, `unit`, `nrvPercent` | One entry per on-pack micronutrient row. |
| `NutritionBasis` | `"per_100g" \| "per_100ml" \| "per_serving" \| "unknown"` | Detected from the table header. |

`Product.macros` is a convenience mirror of `product.nutrition?.macros ?? null`.

### `searchByNutrition(query, opts)`

```ts
client.searchByNutrition(query: string, opts?: {
  where?:   NutritionFilter;   // macro/micro range constraints
  sort?:    NutritionSort;     // { by: MacroFilterKey | microName, dir?: "asc" | "desc" }
  hydrate?: number;            // max candidates to fetch nutrition for (default 20)
  limit?:   number;            // trim final results list
}) => Promise<{ results: Product[]; hydrated: number; failed: number; hasMore: boolean }>
```

Runs a keyword search, fetches nutrition for the top `hydrate` results (one throttled product call each), then applies `filterByNutrition` locally. `hydrated` is the number of products successfully fetched; `failed` is how many candidates whose detail fetch returned **not-found** (e.g. a discontinued/regional SKU that 404s) and were soft-skipped. A genuine error — rate-limit, bad key, expired auth, or transport — still propagates and rejects the whole call, rather than being silently counted as a `failed`. `hasMore` is true when the catalogue had more keyword matches than were hydrated.

> This filters *within* a search result — it does not scan the whole catalogue. Cost is bounded by `hydrate` (default 20).

### Pure utilities (named exports)

| Export | Signature | Notes |
| --- | --- | --- |
| `parseNutrition` | `(rows: unknown[]) => Nutrition \| null` | Normalizes raw Tesco nutrition rows. Returns `null` for empty or unparseable input. |
| `filterByNutrition` | `(products: Product[], opts: { where?, sort?, basis? }) => Product[]` | Pure filter + sort. Drops products with no nutrition when `where` or `sort` is given. |
| `resizeImageUrl` | `(imageUrl: string \| null, size: { width: number; height: number }) => string \| null` | Sets Tesco image `w`/`h` query params for thumbnails or larger packshots. |

### CLI

```bash
basketeer nutrition <sku>
# Prints the normalized Nutrition object (macros + micros) for a product.

basketeer search "<query>" --min-protein <g> --max-sugar <g> --sort <field> --hydrate <n>
# Nutrition-filtered search. Branches into searchByNutrition when any nutrition flag is set.
```

### MCP tools

| Tool | Input | Notes |
| --- | --- | --- |
| `basketeer_nutrition` | `{ sku: string }` | Returns the `Nutrition` object for a product. |
| `basketeer_search_by_nutrition` | `{ query, minProtein?, maxSugar?, sortBy?, hydrate?, limit? }` | Nutrition-filtered search. Returns `{ results, hydrated, failed, hasMore }`. |

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
- `LineRejectedError` — Tesco rejected the line passed to `basket.add`/`set`/`remove` (never assume a write succeeded). The batch `basket.update` reports rejections on `.rejected` instead.
- `ItemUnavailableError` — the SKU passed to `basket.add`/`set` is unavailable for the basket's slot/store (`isForSale` false). Tesco accepts it silently then drops it at checkout, so the client rolls the line back and throws this; affected SKUs are on `.skus`. The batch `basket.update` reports these on `.unavailable` instead.
- `GraphQLRequestError` — a non-auth GraphQL error (full detail on `.errors`; the message is scrubbed).
