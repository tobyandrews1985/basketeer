// Public API surface. Everything exported here is part of the semver contract;
// internal modules (transport, queries, parsers, session-manager) are not.

export { Basketeer } from "./client.js";
export type { BasketeerOptions, BasketItemInput, Amendment } from "./client.js";

// Storage seam
export { FileTokenStore } from "./store/file-store.js";
export { MemoryTokenStore } from "./store/memory-store.js";
export type { TokenStore } from "./store/types.js";

// Auth seam
export type { AuthBackend, Credentials, OtpProvider } from "./auth/types.js";
export { sessionFromCookies, keepCookie } from "./auth/harvest.js";

// Models
export type {
  Price,
  Promotion,
  PackSize,
  Product,
  SearchResult,
  SearchPage,
  BasketLine,
  Basket,
  Slot,
  BookedSlot,
  OrderItem,
  OrderSlot,
  OrderAddress,
  Order,
  Session,
} from "./models.js";

// Errors
export {
  BasketeerError,
  AuthExpiredError,
  RateLimitedError,
  ApiKeyError,
  NotFoundError,
  GraphQLRequestError,
  LineRejectedError,
} from "./errors.js";

// Config & helpers
export {
  PUBLIC_API_KEY,
  ENDPOINT,
  CHECKOUT_URL,
  FULFILMENT_TYPE,
  PENDING_ORDER_CONTEXTS,
  categoryFacet,
} from "./operations.js";
export type { FulfilmentType, OrderContext } from "./operations.js";
