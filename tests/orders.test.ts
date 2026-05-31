import { describe, expect, it } from "vitest";
import { Basketeer } from "../src/client.js";
import { SESSION, stubFetch } from "./helpers.js";

const UPCOMING_ORDERS_BODY = [
  {
    data: {
      orderSearch: {
        orders: [
          {
            id: "order-id-1",
            orderNo: "100200300",
            status: "Pending",
            totalPrice: 82.45,
            totalItems: 27,
            isInAmend: true,
            amendExpiryTime: "2026-06-01T23:45:00+01:00",
            shoppingMethod: "delivery",
            slot: {
              id: "slot-1",
              start: "2026-06-02T10:00:00+01:00",
              end: "2026-06-02T11:00:00+01:00",
              charge: 4.5,
            },
            address: {
              name: "Toby A",
              city: "London",
              addressLine1: "1 High St",
              postcode: "AB1 2CD",
            },
            items: [
              {
                id: "line-1",
                quantity: 2,
                unit: "pcs",
                weight: null,
                product: { id: "111", title: "Milk" },
              },
            ],
          },
        ],
      },
    },
  },
];

const LAST_FULFILLED_BODY = [
  {
    data: {
      order: {
        orderNo: "999888777",
        items: [
          {
            id: "l1",
            quantity: 1,
            unit: "pcs",
            weight: null,
            product: { id: "222", title: "Bananas" },
          },
          {
            id: "l2",
            quantity: 3,
            unit: "pcs",
            weight: null,
            product: { id: "333", title: "Eggs" },
          },
        ],
      },
    },
  },
];

describe("orders.list", () => {
  it("sends GetUpcomingOrders and parses orderSearch.orders[] into Order[]", async () => {
    const { impl, calls } = stubFetch([{ body: UPCOMING_ORDERS_BODY }]);
    const t = new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl });
    const orders = await t.orders.list();

    const op = calls[0]!.body[0];
    expect(op.operationName).toBe("GetUpcomingOrders");
    expect(op.extensions.mfeName).toBe("mfe-orders");
    expect(Array.isArray(op.variables.orderContexts)).toBe(true);

    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      id: "order-id-1",
      orderNo: "100200300",
      status: "Pending",
      totalPrice: 82.45,
      totalItems: 27,
      isInAmend: true,
      amendExpiry: "2026-06-01T23:45:00+01:00",
    });
    expect(orders[0]!.items).toHaveLength(1);
    expect(orders[0]!.items[0]).toMatchObject({
      id: "line-1",
      quantity: 2,
      productId: "111",
      title: "Milk",
    });
  });
});

describe("orders.cancel", () => {
  it("sends CancelOrder with {orderNo}", async () => {
    const { impl, calls } = stubFetch([{ body: [{ data: { order: { id: "order-id-1" } } }] }]);
    const t = new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl });
    await t.orders.cancel("100200300");

    const op = calls[0]!.body[0];
    expect(op.operationName).toBe("CancelOrder");
    expect(op.extensions.mfeName).toBe("mfe-orders");
    expect(op.variables).toEqual({ orderNo: "100200300" });
  });
});

describe("orders.lastFulfilled", () => {
  it("sends GetLastFulfilledOrder and parses order{} into an Order", async () => {
    const { impl, calls } = stubFetch([{ body: LAST_FULFILLED_BODY }]);
    const t = new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl });
    const order = await t.orders.lastFulfilled();

    const op = calls[0]!.body[0];
    expect(op.operationName).toBe("GetLastFulfilledOrder");
    expect(op.extensions.mfeName).toBe("mfe-orders");
    expect(op.variables).toEqual({ status: "LastFulfilled" });

    expect(order).not.toBeNull();
    expect(order!.orderNo).toBe("999888777");
    expect(order!.items).toHaveLength(2);
    expect(order!.items[1]).toMatchObject({
      id: "l2",
      quantity: 3,
      productId: "333",
      title: "Eggs",
    });
  });

  it("returns null when no last-fulfilled order exists", async () => {
    const { impl } = stubFetch([{ body: [{ data: { order: null } }] }]);
    const t = new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl });
    expect(await t.orders.lastFulfilled()).toBeNull();
  });
});
