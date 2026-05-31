import { describe, expect, it } from "vitest";
import { Basketeer } from "../src/client.js";
import { SESSION, stubFetch } from "./helpers.js";

const DELIVERY_SLOTS_BODY = [
  {
    data: {
      delivery: [
        {
          __typename: "Slot",
          id: "slot-1",
          start: "2026-06-01T10:00:00+01:00",
          end: "2026-06-01T11:00:00+01:00",
          charge: 4.5,
          status: "Available",
          group: 2,
          price: { beforeDiscount: 4.5, afterDiscount: 0 },
          locationUuid: null,
        },
        {
          __typename: "Slot",
          id: "slot-2",
          start: "2026-06-01T11:00:00+01:00",
          end: "2026-06-01T12:00:00+01:00",
          charge: null,
          status: "UnAvailable",
          group: 2,
          price: { beforeDiscount: null, afterDiscount: null },
          locationUuid: null,
        },
      ],
      fulfilment: { fulfilmentLocation: { locationUuid: "loc-99" } },
    },
  },
];

const COLLECTION_SLOTS_BODY = [
  {
    data: {
      collection: [
        {
          id: "col-1",
          start: "2026-06-02T08:00:00+01:00",
          end: "2026-06-02T09:00:00+01:00",
          charge: 0,
          status: "Available",
          group: 1,
          locationUuid: "store-abc",
          price: { beforeDiscount: 0, afterDiscount: 0 },
        },
      ],
    },
  },
];

const FULFILMENT_BODY = [
  {
    data: {
      fulfilment: {
        slot: {
          id: "slot-1",
          status: "Reserved",
          start: "2026-06-01T10:00:00+01:00",
          end: "2026-06-01T11:00:00+01:00",
          reservationExpiry: "2026-06-01T10:30:00+01:00",
          group: 2,
          locationUuid: "loc-99",
        },
      },
    },
  },
];

describe("slots.list (delivery)", () => {
  it("sends DeliverySlots and parses data.delivery[] into Slot[]", async () => {
    const { impl, calls } = stubFetch([{ body: DELIVERY_SLOTS_BODY }]);
    const t = new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl });
    const slots = await t.slots.list({ start: "2026-06-01", end: "2026-06-01" });

    const op = calls[0]!.body[0];
    expect(op.operationName).toBe("DeliverySlots");
    expect(op.extensions.mfeName).toBe("mfe-slots");
    expect(op.variables).toMatchObject({
      start: "2026-06-01",
      end: "2026-06-01",
      type: "DELIVERY_VAN",
    });

    expect(slots).toHaveLength(2);
    expect(slots[0]).toMatchObject({
      id: "slot-1",
      start: "2026-06-01T10:00:00+01:00",
      end: "2026-06-01T11:00:00+01:00",
      charge: 4.5,
      status: "Available",
      group: 2,
      priceBeforeDiscount: 4.5,
      priceAfterDiscount: 0,
    });
    expect(slots[1]).toMatchObject({
      id: "slot-2",
      charge: null,
      status: "UnAvailable",
      priceBeforeDiscount: null,
      priceAfterDiscount: null,
    });
  });
});

describe("slots.listCollection", () => {
  it("sends CollectionSlots and parses data.collection[] into Slot[]", async () => {
    const { impl, calls } = stubFetch([{ body: COLLECTION_SLOTS_BODY }]);
    const t = new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl });
    const slots = await t.slots.listCollection({
      start: "2026-06-02",
      end: "2026-06-02",
      locationUuid: "store-abc",
    });

    const op = calls[0]!.body[0];
    expect(op.operationName).toBe("CollectionSlots");
    expect(op.extensions.mfeName).toBe("mfe-slots");
    expect(op.variables).toMatchObject({
      start: "2026-06-02",
      end: "2026-06-02",
      locationUuid: "store-abc",
    });

    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      id: "col-1",
      start: "2026-06-02T08:00:00+01:00",
      end: "2026-06-02T09:00:00+01:00",
      charge: 0,
      status: "Available",
      locationUuid: "store-abc",
    });
  });
});

describe("slots.book", () => {
  it("sends the Fulfilment mutation with {slotId, action:'BOOK'} and parses fulfilment.slot", async () => {
    const { impl, calls } = stubFetch([{ body: FULFILMENT_BODY }]);
    const t = new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl });
    const booked = await t.slots.book("slot-1");

    const op = calls[0]!.body[0];
    expect(op.operationName).toBe("Fulfilment");
    expect(op.extensions.mfeName).toBe("mfe-slots");
    expect(op.variables).toEqual({ slotId: "slot-1", action: "BOOK" });

    expect(booked).toMatchObject({
      id: "slot-1",
      status: "Reserved",
      start: "2026-06-01T10:00:00+01:00",
      end: "2026-06-01T11:00:00+01:00",
      reservationExpiry: "2026-06-01T10:30:00+01:00",
      group: 2,
      locationUuid: "loc-99",
    });
  });
});
