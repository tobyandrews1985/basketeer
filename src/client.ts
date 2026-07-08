import type { AuthBackend, Credentials } from "./auth/types.js";
import {
  BasketeerError,
  ItemUnavailableError,
  LineRejectedError,
  NotFoundError,
} from "./errors.js";
import { GraphQLTransport } from "./graphql.js";
import type {
  Basket,
  BasketUpdateResult,
  BookedSlot,
  NutritionFilter,
  NutritionSort,
  Order,
  Product,
  SearchPage,
  SearchResult,
  Session,
  Slot,
} from "./models.js";
import { filterByNutrition } from "./nutrition.js";
import {
  CHECKOUT_URL,
  FULFILMENT_TYPE,
  type FulfilmentType,
  MFE,
  type OrderContext,
  PENDING_ORDER_CONTEXTS,
} from "./operations.js";
import {
  isoDate,
  parseBasket,
  parseBookedSlot,
  parseOrder,
  parseProduct,
  parseProductNode,
  parseSlot,
  type Raw,
} from "./parsers.js";
import {
  AMEND_ORDER,
  CANCEL_AMEND,
  CANCEL_ORDER,
  COLLECTION_SLOTS,
  DELIVERY_SLOTS,
  FULFILMENT,
  GET_BASKET,
  GET_CATEGORY_PRODUCTS,
  GET_FAVOURITES,
  GET_LAST_FULFILLED_ORDER,
  GET_PRODUCT,
  GET_UPCOMING_ORDERS,
  SEARCH,
  UPDATE_BASKET,
} from "./queries.js";
import { SessionManager } from "./session-manager.js";
import type { TokenStore } from "./store/types.js";

export interface BasketeerOptions {
  /** A ready-made session (e.g. harvested elsewhere). */
  session?: Session | null;
  /** Persists/loads the session. */
  store?: TokenStore;
  /** Mints/renews sessions (browser-driven in v1). */
  authBackend?: AuthBackend;
  /** Override the public api key (it rotates ~monthly). */
  apiKey?: string;
  /** Min gap between requests, ms. Default 1000 (polite). */
  throttleMs?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** A raw basket line input for the low-level `basket.update`. */
export interface BasketItemInput {
  id: string;
  newValue: number;
  newUnitChoice?: string;
  adjustment?: boolean;
  substitutionOption?: string;
}

/** Guard for numeric SDK inputs. Throws `RangeError` for non-integer or out-of-range values. */
function reqInt(v: number | undefined, name: string, min: number): void {
  if (v === undefined) return;
  if (!Number.isInteger(v) || v < min) throw new RangeError(`${name} must be an integer >= ${min}`);
}

/**
 * Guard for a basket-line quantity (the low-level `basket.update` escape hatch).
 * Rejects negative, NaN, and Infinity; allows fractional values for weight-priced
 * lines. `JSON.stringify(NaN)` → `null`, which Tesco would silently misread.
 */
function reqQty(v: number, name: string): void {
  if (!Number.isFinite(v) || v < 0) throw new RangeError(`${name} must be a finite number >= 0`);
}

function normaliseItem(item: BasketItemInput): Record<string, unknown> {
  return {
    adjustment: item.adjustment ?? false,
    id: String(item.id),
    newValue: item.newValue,
    newUnitChoice: item.newUnitChoice ?? "pcs",
    substitutionOption: item.substitutionOption ?? "FindSuitableAlternative",
  };
}

/**
 * A handle to an order opened for amendment (see {@link Basketeer.orders}.amend).
 * Its basket ops apply to the amended order; finish by checking out again, or
 * `discard()` to leave the order unchanged.
 */
export interface Amendment {
  readonly orderNo: string;
  /** The order's working basket while amending. */
  get(): Promise<Basket>;
  /** Set a line to an exact quantity (0 removes) on the amended order. */
  set(sku: string, quantity: number, unit?: string): Promise<Basket>;
  /** Remove a line from the amended order. */
  remove(sku: string): Promise<Basket>;
  /** Abandon the amendment, leaving the order unchanged. */
  discard(): Promise<void>;
}

export class Basketeer {
  private readonly transport: GraphQLTransport;
  private readonly sessions: SessionManager;
  private _amendingOrderNo: string | null = null;

  constructor(opts: BasketeerOptions = {}) {
    this.sessions = new SessionManager({
      session: opts.session,
      backend: opts.authBackend,
      store: opts.store,
    });
    this.transport = new GraphQLTransport({
      apiKey: opts.apiKey,
      throttleMs: opts.throttleMs,
      fetchImpl: opts.fetchImpl,
      getAuth: () => this.sessions.authHeaders(),
      onUnauthorized: () => this.sessions.refresh(),
    });
  }

  /** Resume a persisted session, refreshing proactively if it has expired. */
  static async resume(opts: BasketeerOptions = {}): Promise<Basketeer> {
    const client = new Basketeer(opts);
    await client.sessions.load();
    if (client.sessions.isExpired() && opts.authBackend) {
      await client.sessions.refresh();
    }
    return client;
  }

  /** Mint a new session via the configured AuthBackend. */
  async login(credentials?: Credentials): Promise<Session> {
    return this.sessions.login(credentials);
  }

  /** The current session, or null if unauthenticated. */
  get session(): Session | null {
    return this.sessions.current;
  }

  /** True when a (non-expired) session is loaded. */
  get isAuthenticated(): boolean {
    return this.sessions.current !== null && !this.sessions.isExpired();
  }

  /** The order currently open for amendment via `orders.amend`, if any. */
  get amendingOrderNo(): string | null {
    return this._amendingOrderNo;
  }

  // --- reads (anonymous) ----------------------------------------------------

  async getProduct(sku: string): Promise<Product> {
    const data = await this.transport.execute<{ product?: Raw }>({
      operationName: "GetProduct",
      query: GET_PRODUCT,
      variables: { tpnc: String(sku) },
      mfeName: MFE.product,
    });
    if (!data.product) throw new NotFoundError(`No product found for SKU ${sku}`);
    return parseProduct(data.product);
  }

  async search(query: string, opts: { limit?: number; page?: number } = {}): Promise<SearchPage> {
    reqInt(opts.limit, "limit", 1);
    reqInt(opts.page, "page", 1);
    const data = await this.transport.execute<{ search?: { results?: Raw[] } }>({
      operationName: "Search",
      query: SEARCH,
      variables: { query, count: opts.limit ?? 10, page: opts.page ?? 1 },
      mfeName: MFE.search,
    });
    return this.page(data.search?.results, (e) => (e as Raw).node, opts);
  }

  /**
   * Keyword search, then hydrate the top `hydrate` results' nutrition (each a throttled
   * product fetch) and filter/rank locally. The cost is bounded by `hydrate` (default 20)
   * and reported honestly: `hydrated` is how many products were fetched, `failed` how many
   * detail fetches errored (and were skipped, not fatal), and `hasMore` whether the
   * catalogue had more keyword matches than were hydrated.
   */
  async searchByNutrition(
    query: string,
    opts: { where?: NutritionFilter; sort?: NutritionSort; hydrate?: number; limit?: number } = {},
  ): Promise<{ results: Product[]; hydrated: number; failed: number; hasMore: boolean }> {
    reqInt(opts.hydrate, "hydrate", 1);
    reqInt(opts.limit, "limit", 1);
    const cap = opts.hydrate ?? 20;
    const page = await this.search(query, { limit: Math.max(cap, opts.limit ?? 0) });
    const head = page.results.slice(0, cap);

    const hydrated: Product[] = [];
    let failed = 0;
    for (const r of head) {
      try {
        hydrated.push(await this.getProduct(r.sku)); // serial — relies on the 1 req/s transport throttle
      } catch (err) {
        if (err instanceof NotFoundError) {
          failed++;
          continue;
        } // discontinued/regional SKU 404s — soft-skip
        throw err; // rate-limit, bad key, auth, transport, schema — these are real; don't hide them
      }
    }

    let results = filterByNutrition(hydrated, { where: opts.where, sort: opts.sort });
    if (opts.limit != null) results = results.slice(0, opts.limit);
    return { results, hydrated: hydrated.length, failed, hasMore: page.hasMore };
  }

  /**
   * List products in a category. Build `facet` with {@link categoryFacet} (or
   * lift it from a Tesco category-page URL `?...&facet=…`).
   */
  async browseCategory(
    facet: string,
    opts: { limit?: number; page?: number } = {},
  ): Promise<SearchPage> {
    reqInt(opts.limit, "limit", 1);
    reqInt(opts.page, "page", 1);
    const data = await this.transport.execute<{ category?: { results?: Raw[] } }>({
      operationName: "GetCategoryProducts",
      query: GET_CATEGORY_PRODUCTS,
      variables: { facet, count: opts.limit ?? 24, page: opts.page ?? 1 },
      mfeName: MFE.search,
    });
    return this.page(data.category?.results, (e) => (e as Raw).node, { limit: 24, ...opts });
  }

  /** The customer's favourites ("my usuals"). */
  async favourites(opts: { limit?: number; page?: number } = {}): Promise<SearchPage> {
    reqInt(opts.limit, "limit", 1);
    reqInt(opts.page, "page", 1);
    const data = await this.transport.execute<{ favourites?: { products?: Raw[] } }>({
      operationName: "GetFavourites",
      query: GET_FAVOURITES,
      variables: { count: opts.limit ?? 50, page: opts.page ?? 1, sortBy: "TAXONOMY" },
      mfeName: MFE.favourites,
    });
    return this.page(data.favourites?.products, (p) => p, { limit: 50, ...opts });
  }

  /** Shared paging: map nodes → SearchResult, drop nulls, derive `hasMore`. */
  private page(
    raw: Raw[] | undefined,
    node: (item: unknown) => unknown,
    opts: { limit?: number; page?: number },
  ): SearchPage {
    const pageSize = opts.limit ?? 10;
    const rows = raw ?? [];
    const results = rows
      .map((r) => parseProductNode(node(r)))
      .filter((r): r is SearchResult => r !== null);
    return { results, page: opts.page ?? 1, pageSize, hasMore: rows.length >= pageSize };
  }

  // --- basket (requires auth) -----------------------------------------------

  readonly basket = {
    get: (): Promise<Basket> => this.getBasket(),
    /**
     * Increment the line for `sku` by `quantity` (default 1). Reads the current
     * quantity first, so it costs an extra request and is not safe under
     * concurrent edits — use `set` for exact, idempotent quantities.
     */
    add: async (sku: string, quantity = 1, unit = "pcs"): Promise<Basket> => {
      if (!Number.isInteger(quantity) || quantity < 1)
        throw new RangeError("quantity must be an integer >= 1");
      const current = (await this.getBasket()).items.find((i) => i.sku === sku)?.quantity ?? 0;
      return this.updateLine({ id: sku, newValue: current + quantity, newUnitChoice: unit });
    },
    /** Set the line for `sku` to an exact `quantity` (0 removes it). */
    set: (sku: string, quantity: number, unit = "pcs"): Promise<Basket> => {
      if (!Number.isInteger(quantity) || quantity < 0)
        throw new RangeError("quantity must be an integer >= 0");
      return this.updateLine({ id: sku, newValue: quantity, newUnitChoice: unit });
    },
    /** Remove `sku` from the basket. */
    remove: (sku: string): Promise<Basket> => this.updateLine({ id: sku, newValue: 0 }),
    /**
     * Low-level: send raw basket line inputs (and an optional orderId).
     * A batch can partly succeed, so line-level outcomes (`rejected`,
     * `unavailable`) are reported on the result rather than thrown.
     */
    update: (items: BasketItemInput[], orderId?: string): Promise<BasketUpdateResult> =>
      this.updateBasket(items, orderId),
  };

  private async getBasket(): Promise<Basket> {
    const data = await this.transport.execute<{ basket?: Raw }>({
      operationName: "GetBasket",
      query: GET_BASKET,
      variables: {},
      mfeName: MFE.basket,
    });
    return parseBasket(data.basket);
  }

  /** Single-line path for `add`/`set`/`remove`: line-level failures throw. */
  private async updateLine(item: BasketItemInput): Promise<Basket> {
    const { basket, rejected, unavailable } = await this.updateBasket([item]);
    if (rejected.length) throw new LineRejectedError(rejected.join(", "));
    if (unavailable.length) throw new ItemUnavailableError(unavailable);
    return basket;
  }

  private async updateBasket(
    items: BasketItemInput[],
    orderId?: string,
  ): Promise<BasketUpdateResult> {
    for (const item of items) reqQty(item.newValue, "quantity");
    const variables: Record<string, unknown> = { items: items.map(normaliseItem) };
    if (orderId !== undefined) variables.orderId = orderId;
    const data = await this.transport.execute<{ basket?: Raw }>({
      operationName: "UpdateBasket",
      query: UPDATE_BASKET,
      variables,
      mfeName: MFE.basket,
    });
    const updates = ((data.basket?.updates as Raw | undefined)?.items as Raw[]) ?? [];
    const rejected = updates.filter((u) => u.successful === false).map((u) => String(u.id));

    const basket = parseBasket(data.basket);
    // Tesco accepts unavailable lines silently (updates.successful stays true)
    // then drops them at checkout. Mirror its UI: among the SKUs we just added
    // (newValue > 0), roll back any the basket reports as unavailable and
    // report them on the result.
    const added = new Set(items.filter((i) => i.newValue > 0).map((i) => String(i.id)));
    const unavailable = basket.items
      .filter((l) => l.sku != null && added.has(l.sku) && l.available === false)
      .map((l) => l.sku as string);
    if (unavailable.length) {
      // The rollback lines are all newValue 0, so this cannot recurse further.
      const rollback = await this.updateBasket(
        unavailable.map((id) => ({ id, newValue: 0 })),
        orderId,
      );
      return { basket: rollback.basket, rejected, unavailable };
    }
    return { basket, rejected, unavailable };
  }

  // --- orders (requires auth) -----------------------------------------------

  readonly orders = {
    /** List upcoming (pending) orders with their items, slot, and amend window. */
    list: (opts: { contexts?: readonly OrderContext[] } = {}): Promise<Order[]> =>
      this.listOrders(opts),
    /**
     * Open an order for amendment. Returns an {@link Amendment} handle whose
     * basket ops apply to THAT order; finish by checking out again, or call
     * `discard()`. Only works before the order's `amendExpiry`. While amending,
     * `client.amendingOrderNo` reports the open order.
     */
    amend: (orderNo: string): Promise<Amendment> => this.amendOrder(orderNo),
    /** Cancel an order outright (before its amend/cancel cutoff). */
    cancel: (orderNo: string): Promise<void> => this.cancelOrder(orderNo),
    /** The last delivered order (its items), for "reorder my usual shop". */
    lastFulfilled: (): Promise<Order | null> => this.lastFulfilledOrder(),
  };

  private async amendOrder(orderNo: string): Promise<Amendment> {
    await this.orderAction(AMEND_ORDER, "AmendOrder", orderNo);
    this._amendingOrderNo = orderNo;
    return {
      orderNo,
      get: () => this.getBasket(),
      set: (sku, quantity, unit) => this.basket.set(sku, quantity, unit),
      remove: (sku) => this.basket.remove(sku),
      discard: async () => {
        await this.orderAction(CANCEL_AMEND, "CancelAmend", orderNo);
        if (this._amendingOrderNo === orderNo) this._amendingOrderNo = null;
      },
    };
  }

  private async cancelOrder(orderNo: string): Promise<void> {
    await this.orderAction(CANCEL_ORDER, "CancelOrder", orderNo);
    if (this._amendingOrderNo === orderNo) this._amendingOrderNo = null;
  }

  private async lastFulfilledOrder(): Promise<Order | null> {
    const data = await this.transport.execute<{ order?: Raw }>({
      operationName: "GetLastFulfilledOrder",
      query: GET_LAST_FULFILLED_ORDER,
      variables: { status: "LastFulfilled" },
      mfeName: MFE.orders,
    });
    return data.order ? parseOrder(data.order) : null;
  }

  private async listOrders(opts: { contexts?: readonly OrderContext[] }): Promise<Order[]> {
    const data = await this.transport.execute<{ orderSearch?: { orders?: Raw[] } }>({
      operationName: "GetUpcomingOrders",
      query: GET_UPCOMING_ORDERS,
      variables: { orderContexts: opts.contexts ?? PENDING_ORDER_CONTEXTS },
      mfeName: MFE.orders,
    });
    return (data.orderSearch?.orders ?? []).map(parseOrder);
  }

  private async orderAction(query: string, operationName: string, orderNo: string): Promise<void> {
    await this.transport.execute({
      operationName,
      query,
      variables: { orderNo },
      mfeName: MFE.orders,
    });
  }

  // --- checkout (boundary: pure HTTP up to payment) -------------------------

  /**
   * Prepare for payment. Returns the current basket and the URL where payment
   * is completed **in a browser**. basketeer deliberately stops here:
   * Tesco's payment step is a separate CSRF-protected checkout app + 3-D Secure
   * card authentication — browser-bound by design and PCI/fraud-sensitive. Fill
   * the basket and book a slot via this SDK, then complete payment at `url`.
   */
  async checkout(): Promise<{ basket: Basket; url: string }> {
    return { basket: await this.getBasket(), url: CHECKOUT_URL };
  }

  // --- slots (requires auth) ------------------------------------------------

  readonly slots = {
    /** List delivery slots over a date window (default today..+6 days). */
    list: (opts: { start?: string; end?: string; type?: FulfilmentType } = {}): Promise<Slot[]> =>
      this.listSlots(opts),
    /** List click-and-collect slots for a store (`locationUuid`); default today..+6 days. */
    listCollection: (
      opts: { start?: string; end?: string; locationUuid?: string } = {},
    ): Promise<Slot[]> => this.listCollectionSlots(opts),
    /** Reserve a slot by id. Held until `reservationExpiry`; check out before then. */
    book: (slotId: string): Promise<BookedSlot> => this.fulfilment(slotId, "BOOK"),
    /** Release a previously-reserved slot. */
    release: (slotId: string): Promise<BookedSlot> => this.fulfilment(slotId, "UNBOOK"),
  };

  private async listSlots(opts: {
    start?: string;
    end?: string;
    type?: FulfilmentType;
  }): Promise<Slot[]> {
    const data = await this.transport.execute<{ delivery?: Raw[] }>({
      operationName: "DeliverySlots",
      query: DELIVERY_SLOTS,
      variables: {
        start: opts.start ?? isoDate(0),
        end: opts.end ?? isoDate(6),
        type: opts.type ?? FULFILMENT_TYPE.delivery,
      },
      mfeName: MFE.slots,
    });
    return (data.delivery ?? []).map(parseSlot);
  }

  private async listCollectionSlots(opts: {
    start?: string;
    end?: string;
    locationUuid?: string;
  }): Promise<Slot[]> {
    const data = await this.transport.execute<{ collection?: Raw[] }>({
      operationName: "CollectionSlots",
      query: COLLECTION_SLOTS,
      variables: {
        start: opts.start ?? isoDate(0),
        end: opts.end ?? isoDate(6),
        locationUuid: opts.locationUuid ?? null,
      },
      mfeName: MFE.slots,
    });
    return (data.collection ?? []).map(parseSlot);
  }

  private async fulfilment(slotId: string, action: "BOOK" | "UNBOOK"): Promise<BookedSlot> {
    const data = await this.transport.execute<{ fulfilment?: { slot?: Raw } }>({
      operationName: "Fulfilment",
      query: FULFILMENT,
      variables: { slotId, action },
      mfeName: MFE.slots,
    });
    const slot = data.fulfilment?.slot;
    if (!slot) throw new BasketeerError(`Slot ${action} returned no slot`);
    return parseBookedSlot(slot);
  }
}
