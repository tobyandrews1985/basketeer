/**
 * GraphQL operation strings for `xapi.tesco.com`, ported from observed traffic.
 * Internal — not part of the public API. Config/constants live in operations.ts.
 */

export const GET_PRODUCT = `
query GetProduct($tpnc: String!) {
  product(tpnc: $tpnc) {
    tpnb tpnc title brandName defaultImageUrl
    price { actual unitPrice unitOfMeasure }
    promotions {
      description
      startDate
      endDate
      attributes
      price { afterDiscount beforeDiscount }
    }
    details {
      packSize { value units }
      nutrition { name value1 value2 value3 }
      ingredients
    }
  }
}`.trim();

export const SEARCH = `
query Search($query: String!, $page: Int = 1, $count: Int) {
  search(query: $query, page: $page, count: $count) {
    results {
      node {
        __typename
        ... on ProductInterface {
          tpnc tpnb title brandName defaultImageUrl
          sellers {
            results {
              price { actual unitPrice unitOfMeasure }
              promotions {
                description
                startDate
                endDate
                attributes
                price { afterDiscount beforeDiscount }
              }
            }
          }
        }
      }
    }
  }
}`.trim();

export const GET_CATEGORY_PRODUCTS = `
query GetCategoryProducts($facet: ID, $page: Int = 1, $count: Int) {
  category(facet: $facet, page: $page, count: $count) {
    results {
      node {
        __typename
        ... on ProductInterface {
          tpnc tpnb title brandName defaultImageUrl
          sellers {
            results {
              price { actual unitPrice unitOfMeasure }
              promotions { description startDate endDate attributes price { afterDiscount beforeDiscount } }
            }
          }
        }
      }
    }
  }
}`.trim();

export const GET_FAVOURITES = `
query GetFavourites($page: Int = 1, $count: Int, $sortBy: String) {
  favourites(page: $page, count: $count, sortBy: $sortBy) {
    products {
      __typename
      ... on ProductInterface {
        tpnc tpnb title brandName defaultImageUrl
        sellers {
          results {
            price { actual unitPrice unitOfMeasure }
            promotions { description startDate endDate attributes price { afterDiscount beforeDiscount } }
          }
        }
      }
    }
  }
}`.trim();

export const GET_BASKET = `
query GetBasket {
  basket {
    id
    guidePrice
    isInAmend
    amendExpiry
    shoppingMethod
    items {
      __typename
      id
      unit
      weight
      cost
      quantity
      product { id __typename }
    }
  }
}`.trim();

// Selects the same fields as GET_BASKET so the Basket returned from a write has
// full fidelity (guidePrice / isInAmend / amendExpiry / unit / weight), not a
// partial object.
export const UPDATE_BASKET = `
mutation UpdateBasket($items: [BasketLineItemInputType], $orderId: ID) {
  basket(items: $items, orderId: $orderId) {
    id
    guidePrice
    isInAmend
    amendExpiry
    shoppingMethod
    items {
      __typename
      id
      unit
      weight
      cost
      quantity
      product { id __typename }
    }
    updates {
      items { id successful __typename }
    }
  }
}`.trim();

// ---- orders ----------------------------------------------------------------

export const GET_UPCOMING_ORDERS = `
query GetUpcomingOrders($orderContexts: [OrderContextType]) {
  orderSearch(orderContexts: $orderContexts) {
    orders {
      id
      orderNo
      status
      totalPrice
      totalItems
      isInAmend
      amendExpiryTime
      shoppingMethod
      paymentMode
      slot { id start end charge }
      address { name city addressLine1 postcode }
      items { id quantity unit weight product { id title } }
    }
  }
}`.trim();

// One unified mutation drives the order lifecycle: action ∈ AMEND | CANCEL | CANCEL_AMEND.
export const AMEND_ORDER = `
mutation AmendOrder($orderNo: ID!) {
  order(orderNo: $orderNo, action: AMEND) { id orderNo }
}`.trim();

export const CANCEL_ORDER = `
mutation CancelOrder($orderNo: ID!) {
  order(orderNo: $orderNo, action: CANCEL) { id }
}`.trim();

export const CANCEL_AMEND = `
mutation CancelAmend($orderNo: ID!) {
  order(orderNo: $orderNo, action: CANCEL_AMEND) { id orderNo }
  basket { id isInAmend amendExpiry }
}`.trim();

// Last delivered order — the source for "reorder my usual shop".
export const GET_LAST_FULFILLED_ORDER = `
query GetLastFulfilledOrder($status: OrderStatusInputType) {
  order(status: $status) {
    orderNo
    items { id quantity unit weight product { id title } }
  }
}`.trim();

// ---- slots -----------------------------------------------------------------

export const DELIVERY_SLOTS = `
query DeliverySlots($start: String, $end: String, $group: Int, $type: FulfilmentTypeType) {
  delivery(start: $start, end: $end, group: $group) {
    ...Slot
    __typename
  }
  fulfilment(type: $type, range: {start: $start, end: $end}) {
    ...Fulfilment
    __typename
  }
}

fragment Slot on SlotInterface {
  id
  start
  end
  charge
  status
  group
  price {
    beforeDiscount
    afterDiscount
    __typename
  }
  locationUuid
  __typename
}

fragment Fulfilment on FulfilmentType {
  fulfilmentLocation {
    locationUuid
    __typename
  }
  metadata {
    preBookedOrderDays
    __typename
  }
  __typename
}`.trim();

export const COLLECTION_SLOTS = `
query CollectionSlots($start: String, $end: String, $locationUuid: ID) {
  collection(start: $start, end: $end, locationUuid: $locationUuid) {
    id start end charge status group locationUuid
    price { beforeDiscount afterDiscount }
  }
}`.trim();

// Reserve (action "BOOK") or release (action "UNBOOK") a slot by its id.
// `action` mirrors the server's `SlotActions` enum.
export const FULFILMENT = `
mutation Fulfilment($slotId: ID, $action: SlotActions) {
  fulfilment(slotId: $slotId, action: $action) {
    slot {
      id
      status
      start
      end
      reservationExpiry
      group
      locationUuid
      __typename
    }
    __typename
  }
}`.trim();
