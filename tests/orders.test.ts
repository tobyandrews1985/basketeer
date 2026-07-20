import { describe, expect, it } from "vitest";
import { Basketeer } from "../src/client.js";
import { BasketeerError } from "../src/errors.js";
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

/** A GetOrderHistory response body with one minimal Previous order per id. */
function historyBody(ids: string[]) {
  return [
    {
      data: {
        orderSearch: {
          orders: ids.map((id) => ({
            id,
            orderNo: `no-${id}`,
            status: "Previous",
            totalPrice: 10,
            totalItems: 1,
            isInAmend: false,
            amendExpiryTime: null,
            shoppingMethod: "delivery",
            slot: null,
            address: null,
            items: [],
          })),
        },
      },
    },
  ];
}

describe("orders.history", () => {
  it("sends GetOrderHistory with default previous-grocery contexts, count 25, offset 0 (and no page)", async () => {
    const { impl, calls } = stubFetch([{ body: historyBody(["a"]) }]);
    const t = new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl });
    const page = await t.orders.history();

    const op = calls[0]!.body[0];
    expect(op.operationName).toBe("GetOrderHistory");
    expect(op.extensions.mfeName).toBe("mfe-orders");
    expect(op.variables).toEqual({
      orderContexts: [{ type: "GROCERY", statuses: ["Previous"] }],
      count: 25,
      offset: 0,
    });

    expect(page.orders).toHaveLength(1);
    expect(page.orders[0]).toMatchObject({ id: "a", orderNo: "no-a", status: "Previous" });
    expect(page.nextOffset).toBeNull(); // short page (1 < 25) is terminal
  });

  it("forwards offset/limit/contexts and advances nextOffset past a full page", async () => {
    const contexts = [{ type: "GROCERY", statuses: ["Previous", "Cancelled"] }];
    const { impl, calls } = stubFetch([{ body: historyBody(["a", "b"]) }]);
    const t = new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl });
    const page = await t.orders.history({ offset: 3, limit: 2, contexts });

    expect(calls[0]!.body[0].variables).toEqual({ orderContexts: contexts, count: 2, offset: 3 });
    expect(page.orders.map((o) => o.id)).toEqual(["a", "b"]);
    expect(page.nextOffset).toBe(5); // full page: another request is needed to know
  });

  it("terminates with an empty final page when the total is an exact multiple of limit", async () => {
    const { impl } = stubFetch([{ body: historyBody(["a", "b"]) }, { body: historyBody([]) }]);
    const t = new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl });

    const first = await t.orders.history({ limit: 2 });
    expect(first.nextOffset).toBe(2);
    const last = await t.orders.history({ offset: first.nextOffset!, limit: 2 });
    expect(last.orders).toEqual([]);
    expect(last.nextOffset).toBeNull();
  });

  it("rejects invalid offset/limit before any request reaches Tesco", async () => {
    const { impl, calls } = stubFetch([{ body: historyBody([]) }]);
    const t = new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl });

    for (const offset of [-1, 1.5, NaN, Infinity])
      await expect(t.orders.history({ offset })).rejects.toThrow(RangeError);
    // limit: 0 means UNBOUNDED to Tesco and negatives return empty — never forward them.
    for (const limit of [0, -1, 2.5, NaN, Infinity, 101])
      await expect(t.orders.history({ limit })).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it("treats a missing orderSearch or non-array orders as a contract error, not a terminal page", async () => {
    for (const body of [[{ data: {} }], [{ data: { orderSearch: { orders: "nope" } } }]]) {
      const { impl } = stubFetch([{ body }]);
      const t = new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl });
      await expect(t.orders.history()).rejects.toThrow(BasketeerError);
    }
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
