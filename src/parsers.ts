/**
 * Raw GraphQL → typed model parsers. Kept separate from the client so they can
 * be unit-tested against captured fixtures, and so the orchestration stays lean.
 *
 * Tesco's GraphQL shape drifts (the public api key rotates ~monthly), so every
 * parser is defensive: it reads untrusted `unknown`, narrows with small
 * accessors, tolerates nulls/missing fields, and never throws on a sparse array.
 */
import type {
  Basket,
  BasketLine,
  BookedSlot,
  CatchWeightOption,
  Order,
  OrderItem,
  PackSize,
  Price,
  Product,
  ProductQuantityRules,
  Promotion,
  SearchResult,
  Slot,
} from "./models.js";
import { parseNutrition } from "./nutrition.js";

/** A decoded-JSON object whose fields are still untrusted. */
export type Raw = Record<string, unknown>;

const obj = (v: unknown): Raw => (v !== null && typeof v === "object" ? (v as Raw) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** Array of objects, with null/non-object elements dropped. */
const objs = (v: unknown): Raw[] =>
  arr(v).filter((x): x is Raw => x !== null && typeof x === "object");
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const id = (v: unknown): string | null => (v == null ? null : String(v));

function parsePrice(v: unknown): Price {
  const p = obj(v);
  return {
    actual: num(p.actual),
    unitPrice: num(p.unitPrice),
    unitOfMeasure: str(p.unitOfMeasure),
  };
}

export function parsePromotions(v: unknown): Promotion[] {
  return objs(v).map((p) => {
    const price = obj(p.price);
    return {
      description: str(p.description) ?? "",
      startDate: str(p.startDate),
      endDate: str(p.endDate),
      attributes: arr(p.attributes).filter((a): a is string => typeof a === "string"),
      priceAfterDiscount: num(price.afterDiscount),
      priceBeforeDiscount: num(price.beforeDiscount),
    };
  });
}

function parsePackSize(v: unknown): PackSize | null {
  const first = Array.isArray(v) ? v[0] : v;
  const p = obj(first);
  const units = str(p.units);
  const value = Number(p.value); // Tesco sends packSize.value as a numeric string
  return units && Number.isFinite(value) ? { value, units } : null;
}

function parseCatchWeightOptions(v: unknown): CatchWeightOption[] {
  return objs(v)
    .map((entry) => {
      const price = num(entry.price);
      const weight = num(entry.weight);
      if (price === null || weight === null) return null;
      return { price, weight, default: Boolean(entry.default) };
    })
    .filter((entry): entry is CatchWeightOption => entry !== null);
}

function parseQuantityRules(v: Raw): ProductQuantityRules {
  return {
    productType: str(v.productType),
    averageWeight: num(v.averageWeight),
    minWeight: num(v.minWeight),
    maxWeight: num(v.maxWeight),
    increment: num(v.increment),
    bulkBuyLimit: num(v.bulkBuyLimit),
    catchWeightOptions: parseCatchWeightOptions(v.catchWeightList),
  };
}

export function parseProduct(v: unknown): Product {
  const node = obj(v);
  const details = obj(node.details);
  const nutrition = parseNutrition(arr(details.nutrition));
  return {
    sku: id(node.tpnc) ?? "",
    tpnb: id(node.tpnb),
    title: str(node.title) ?? "",
    brand: str(node.brandName),
    imageUrl: str(node.defaultImageUrl),
    price: parsePrice(node.price),
    available: bool(node.isForSale),
    packSize: parsePackSize(details.packSize),
    quantityRules: parseQuantityRules(node),
    promotions: parsePromotions(node.promotions),
    nutrition,
    macros: nutrition?.macros ?? null,
    raw: v,
  };
}

/**
 * Map a ProductInterface node (search / category / favourites) to a SearchResult,
 * or `null` for non-product union members and nodes without a `tpnc` (callers
 * filter these out rather than fabricating an `"undefined"` SKU).
 */
export function parseProductNode(v: unknown): SearchResult | null {
  const node = obj(v);
  if (node.tpnc == null) return null;
  const seller = obj(arr(obj(node.sellers).results)[0]);
  const promotions = parsePromotions(seller.promotions);
  return {
    sku: String(node.tpnc),
    tpnb: id(node.tpnb),
    title: str(node.title) ?? "",
    brand: str(node.brandName),
    imageUrl: str(node.defaultImageUrl),
    price: parsePrice(seller.price),
    quantityRules: parseQuantityRules(node),
    available: bool(node.isForSale),
    onOffer: promotions.length > 0,
    promotions,
  };
}

export function parseBasket(v: unknown): Basket {
  const node = obj(v);
  const items: BasketLine[] = objs(node.items).map((it) => ({
    id: id(it.id) ?? "",
    sku: id(obj(it.product).id),
    quantity: num(it.quantity) ?? 0,
    unit: str(it.unit),
    cost: num(it.cost),
    available: bool(obj(it.product).isForSale),
  }));
  return {
    id: id(node.id),
    guidePrice: num(node.guidePrice),
    isInAmend: Boolean(node.isInAmend),
    amendExpiry: str(node.amendExpiry),
    shoppingMethod: str(node.shoppingMethod),
    items,
    raw: v ?? null,
  };
}

export function parseSlot(v: unknown): Slot {
  const node = obj(v);
  const price = obj(node.price);
  return {
    id: id(node.id) ?? "",
    start: str(node.start) ?? "",
    end: str(node.end) ?? "",
    charge: num(node.charge),
    status: str(node.status) ?? "",
    group: num(node.group),
    priceBeforeDiscount: num(price.beforeDiscount),
    priceAfterDiscount: num(price.afterDiscount),
    locationUuid: id(node.locationUuid),
  };
}

export function parseBookedSlot(v: unknown): BookedSlot {
  const node = obj(v);
  return {
    id: id(node.id) ?? "",
    status: str(node.status) ?? "",
    start: str(node.start) ?? "",
    end: str(node.end) ?? "",
    reservationExpiry: str(node.reservationExpiry),
    group: num(node.group),
    locationUuid: id(node.locationUuid),
  };
}

export function parseOrder(v: unknown): Order {
  const node = obj(v);
  const slot = obj(node.slot);
  const addr = obj(node.address);
  const items: OrderItem[] = objs(node.items).map((it) => {
    const product = obj(it.product);
    return {
      id: id(it.id) ?? "",
      quantity: num(it.quantity) ?? 0,
      unit: str(it.unit),
      weight: num(it.weight),
      productId: id(product.id),
      title: str(product.title) ?? "",
    };
  });
  return {
    id: id(node.id) ?? "",
    orderNo: id(node.orderNo) ?? "",
    status: str(node.status) ?? "",
    totalPrice: num(node.totalPrice),
    totalItems: num(node.totalItems),
    isInAmend: Boolean(node.isInAmend),
    amendExpiry: str(node.amendExpiryTime),
    shoppingMethod: str(node.shoppingMethod),
    slot: node.slot
      ? { id: id(slot.id), start: str(slot.start), end: str(slot.end), charge: num(slot.charge) }
      : null,
    address: node.address
      ? {
          name: str(addr.name),
          city: str(addr.city),
          addressLine1: str(addr.addressLine1),
          postcode: str(addr.postcode),
        }
      : null,
    items,
    raw: v,
  };
}

/** YYYY-MM-DD `offsetDays` from today, in LOCAL time (Tesco slot dates are UK-local). */
export function isoDate(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
