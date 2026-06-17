/** Typed domain models. Raw GraphQL nodes are kept on `.raw` for escape hatches. */

export interface Price {
  actual: number | null;
  unitPrice: number | null;
  unitOfMeasure: string | null;
}

export interface Promotion {
  description: string;
  startDate: string | null;
  endDate: string | null;
  attributes: string[];
  priceAfterDiscount: number | null;
  priceBeforeDiscount: number | null;
}

export interface PackSize {
  value: number;
  units: string;
}

export interface Product {
  /** tpnc — the SKU used for product lookup and basket ops. */
  sku: string;
  tpnb: string | null;
  title: string;
  brand: string | null;
  imageUrl: string | null;
  price: Price;
  packSize: PackSize | null;
  promotions: Promotion[];
  /** Normalized nutrition, or null if Tesco returned none / it was unparseable. */
  nutrition: Nutrition | null;
  /** Convenience mirror of `nutrition?.macros`. */
  macros: Macros | null;
  raw: unknown;
}

export interface SearchResult {
  sku: string;
  tpnb: string | null;
  title: string;
  brand: string | null;
  imageUrl: string | null;
  price: Price;
  onOffer: boolean;
  promotions: Promotion[];
}

/** A page of product results, with the signal needed to page reliably. */
export interface SearchPage {
  results: SearchResult[];
  page: number;
  pageSize: number;
  /** True if the server returned a full page (more may exist). */
  hasMore: boolean;
}

export interface BasketLine {
  id: string;
  sku: string | null;
  quantity: number;
  unit: string | null;
  cost: number | null;
}

export interface Basket {
  id: string | null;
  guidePrice: number | null;
  isInAmend: boolean;
  /** ISO time the amend window closes (when `isInAmend`), else null. */
  amendExpiry: string | null;
  shoppingMethod: string | null;
  items: BasketLine[];
  raw: unknown;
}

export interface Slot {
  /** Opaque slot id — pass to slots.book(). */
  id: string;
  start: string;
  end: string;
  /** Delivery charge for this slot, or null. */
  charge: number | null;
  /** e.g. "Available" / "UnAvailable" / "Booked". */
  status: string;
  group: number | null;
  priceBeforeDiscount: number | null;
  priceAfterDiscount: number | null;
  locationUuid: string | null;
}

export interface BookedSlot {
  id: string;
  status: string;
  start: string;
  end: string;
  /** When the reservation lapses if you don't check out. */
  reservationExpiry: string | null;
  group: number | null;
  locationUuid: string | null;
}

export interface OrderItem {
  id: string;
  quantity: number;
  unit: string | null;
  weight: number | null;
  productId: string | null;
  title: string;
}

export interface OrderSlot {
  id: string | null;
  start: string | null;
  end: string | null;
  charge: number | null;
}

export interface OrderAddress {
  name: string | null;
  city: string | null;
  addressLine1: string | null;
  postcode: string | null;
}

export interface Order {
  id: string;
  orderNo: string;
  status: string;
  totalPrice: number | null;
  totalItems: number | null;
  /** True while the order is open for amendment. */
  isInAmend: boolean;
  /** ISO time after which the order can no longer be amended/cancelled. */
  amendExpiry: string | null;
  shoppingMethod: string | null;
  slot: OrderSlot | null;
  address: OrderAddress | null;
  items: OrderItem[];
  raw: unknown;
}

/**
 * An authenticated session. For the browser-minted hybrid (v1), `accessToken`
 * is the harvested `OAuth.AccessToken` bearer and `customerUuid` is the `UUID`
 * cookie. `cookies` carries the tesco.com cookies replayed on writes (auth +
 * Akamai bot-mitigation cookies). Renewal is performed by the AuthBackend.
 */
export interface Session {
  accessToken: string;
  customerUuid: string;
  cookies: Record<string, string>;
  /** epoch ms; parsed from the JWT `exp` when available, else undefined. */
  accessTokenExpiry?: number;
}

export type NutritionBasis = "per_100g" | "per_100ml" | "per_serving" | "unknown";

export interface Macros {
  energyKcal: number | null;
  energyKj: number | null;
  protein: number | null;
  fat: number | null;
  saturates: number | null;
  carbs: number | null;
  sugars: number | null;
  fibre: number | null;
  salt: number | null;
}

export interface Micronutrient {
  name: string;
  amount: number | null;
  unit: string | null;
  nrvPercent: number | null;
}

export interface Nutrition {
  basis: NutritionBasis;
  macros: Macros;
  micros: Micronutrient[];
  raw: unknown[];
}

export interface Range {
  min?: number;
  max?: number;
}

/** Macro fields that can be filtered/sorted on. Excludes energyKj (use energyKcal). */
export type MacroFilterKey =
  | "energyKcal"
  | "protein"
  | "fat"
  | "saturates"
  | "carbs"
  | "sugars"
  | "fibre"
  | "salt";

export type NutritionFilter = Partial<Record<MacroFilterKey, Range>> & {
  micro?: { name: string; min?: number; max?: number }[];
};

export interface NutritionSort {
  by: MacroFilterKey | (string & {}); // a MacroFilterKey or a micronutrient name
  dir?: "asc" | "desc";
}
