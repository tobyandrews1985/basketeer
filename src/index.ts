// Public API surface. Everything exported here is part of the semver contract;
// internal modules (transport, queries, parsers, session-manager) are not.

export { keepCookie, sessionFromCookies } from "./auth/harvest.js";
export type { HttpAuthOptions } from "./auth/http.js";
export { HttpAuthBackend } from "./auth/http.js";
// Auth seam
export type { AuthBackend, Credentials, OtpProvider } from "./auth/types.js";
export type { Amendment, BasketeerOptions, BasketItemInput } from "./client.js";
export { Basketeer, MAX_HISTORY_PAGE_SIZE, MAX_PRODUCT_BATCH_SIZE } from "./client.js";
// Errors
export {
  ApiKeyError,
  AuthExpiredError,
  BasketeerError,
  GraphQLRequestError,
  ItemUnavailableError,
  LineRejectedError,
  MarketMismatchError,
  NotFoundError,
  RateLimitedError,
} from "./errors.js";
export type { ImageSize } from "./images.js";
export { resizeImageUrl } from "./images.js";
// Markets
export type { Market, MarketCode, MarketSupport } from "./market.js";
export {
  checkoutUrl,
  DEFAULT_MARKET,
  groceriesUrl,
  isMarketCode,
  isMarketCookieDomain,
  loadMarketConfig,
  loginUrl,
  MARKETS,
  marketFromEnv,
  marketSupportNotice,
  parseMarketConfig,
  refreshUrl,
  resolveMarket,
} from "./market.js";
// Models
export type {
  Basket,
  BasketLine,
  BasketUpdateResult,
  BookedSlot,
  CatchWeightOption,
  MacroFilterKey,
  Macros,
  Micronutrient,
  Nutrition,
  NutritionBasis,
  NutritionFilter,
  NutritionSort,
  Order,
  OrderAddress,
  OrderHistoryPage,
  OrderItem,
  OrderSlot,
  PackSize,
  Price,
  Product,
  ProductQuantityRules,
  Promotion,
  Range,
  SearchPage,
  SearchResult,
  Session,
  ShoppingList,
  ShoppingListItem,
  ShoppingListItemInput,
  ShoppingListSummary,
  ShoppingListType,
  Slot,
} from "./models.js";
// Nutrition
export { filterByNutrition, parseNutrition } from "./nutrition.js";
export type { FulfilmentType, OrderContext } from "./operations.js";
// Config & helpers
export {
  CHECKOUT_URL,
  categoryFacet,
  DEFAULT_SHOPPING_LIST_NAME,
  ENDPOINT,
  FULFILMENT_TYPE,
  PENDING_ORDER_CONTEXTS,
  PREVIOUS_ORDER_CONTEXTS,
  PUBLIC_API_KEY,
  SHOPPING_LIST_TYPES,
} from "./operations.js";
// Shopping lists
export { mergeShoppingListItems } from "./parsers.js";
// Storage seam
export { defaultSessionPath, FileTokenStore } from "./store/file-store.js";
export { MemoryTokenStore } from "./store/memory-store.js";
export type { TokenStore } from "./store/types.js";
