// Public API surface. Everything exported here is part of the semver contract;
// internal modules (transport, queries, parsers, session-manager) are not.

export { keepCookie, sessionFromCookies } from "./auth/harvest.js";
// Auth seam
export type { AuthBackend, Credentials, OtpProvider } from "./auth/types.js";
export type { Amendment, BasketeerOptions, BasketItemInput } from "./client.js";
export { Basketeer } from "./client.js";
// Errors
export {
  ApiKeyError,
  AuthExpiredError,
  BasketeerError,
  GraphQLRequestError,
  ItemUnavailableError,
  LineRejectedError,
  NotFoundError,
  RateLimitedError,
} from "./errors.js";
export type { ImageSize } from "./images.js";
export { resizeImageUrl } from "./images.js";
// Models
export type {
  Basket,
  BasketLine,
  BasketUpdateResult,
  BookedSlot,
  MacroFilterKey,
  Macros,
  Micronutrient,
  Nutrition,
  NutritionBasis,
  NutritionFilter,
  NutritionSort,
  Order,
  OrderAddress,
  OrderItem,
  OrderSlot,
  PackSize,
  Price,
  Product,
  Promotion,
  Range,
  SearchPage,
  SearchResult,
  Session,
  Slot,
} from "./models.js";
// Nutrition
export { filterByNutrition, parseNutrition } from "./nutrition.js";
export type { FulfilmentType, OrderContext } from "./operations.js";
// Config & helpers
export {
  CHECKOUT_URL,
  categoryFacet,
  ENDPOINT,
  FULFILMENT_TYPE,
  PENDING_ORDER_CONTEXTS,
  PUBLIC_API_KEY,
} from "./operations.js";
// Storage seam
export { FileTokenStore } from "./store/file-store.js";
export { MemoryTokenStore } from "./store/memory-store.js";
export type { TokenStore } from "./store/types.js";
