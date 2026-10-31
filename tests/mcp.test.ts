import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { Basketeer, BookedSlot } from "../src/index.js";
import { BasketeerError } from "../src/index.js";
import { MARKETS } from "../src/market.js";
import { buildServer, confirmToken } from "../src/mcp-server.js";

/** Connect an MCP client to a server built over a stubbed SDK client (UK unless the stub sets a market). */
async function connect(stub: Basketeer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const withMarket = { ...stub, market: stub.market ?? MARKETS.uk } as unknown as Basketeer;
  await buildServer(withMarket).connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("confirmToken", () => {
  it("is deterministic for the same input", () => {
    expect(confirmToken("cancel:12345")).toBe(confirmToken("cancel:12345"));
  });

  it("returns 8 lowercase hex characters", () => {
    expect(confirmToken("checkout:3:42.5")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("maps different inputs to different tokens", () => {
    expect(confirmToken("cancel:1")).not.toBe(confirmToken("cancel:2"));
    expect(confirmToken("cancel:1")).not.toBe(confirmToken("checkout:1"));
  });
});

describe("buildServer", () => {
  it("is a function exported for wiring/tests", () => {
    expect(typeof buildServer).toBe("function");
  });
});

describe("basket mutation receipts (issue #9)", () => {
  const basket = {
    id: "b1",
    guidePrice: 17.14,
    isInAmend: false,
    amendExpiry: null,
    shoppingMethod: "DELIVERY",
    items: [
      { id: "l1", sku: "111", quantity: 2, unit: "pcs", cost: 3.5, available: true },
      { id: "l2", sku: "222", quantity: 1, unit: "pcs", cost: 1.2, available: true },
    ],
    raw: { __typename: "BasketType", huge: "blob" },
  };

  async function callTool(name: string, args: Record<string, unknown>) {
    const stub = {
      market: MARKETS.uk,
      basket: {
        get: async () => basket,
        set: async () => basket,
        remove: async () => basket,
      },
    } as unknown as Basketeer;
    const client = await connect(stub);
    const res = (await client.callTool({ name, arguments: args })) as unknown as {
      content: [{ text: string }];
    };
    return JSON.parse(res.content[0].text);
  }

  it("basket_set returns a compact receipt, not the basket", async () => {
    const body = await callTool("basketeer_basket_set", { sku: "111", quantity: 2 });
    expect(body).toEqual({
      sku: "111",
      quantity: 2,
      itemCount: 2,
      guidePrice: 17.14,
      isInAmend: false,
    });
  });

  it("basket_remove reports quantity 0 for a sku no longer in the basket", async () => {
    const body = await callTool("basketeer_basket_remove", { sku: "999" });
    expect(body).toEqual({
      sku: "999",
      quantity: 0,
      itemCount: 2,
      guidePrice: 17.14,
      isInAmend: false,
    });
  });

  it("basket_get keeps full contents but strips the raw escape hatch", async () => {
    const body = await callTool("basketeer_basket_get", {});
    expect(body.items).toHaveLength(2);
    expect(body).not.toHaveProperty("raw");
  });
});

describe("basketeer_search select", () => {
  const page = {
    results: [
      {
        sku: "123",
        tpnb: null,
        title: "Milk",
        brand: null,
        imageUrl: null,
        price: { actual: 1.2, unitPrice: 1.05, unitOfMeasure: "ltr" },
        onOffer: false,
        promotions: [],
      },
    ],
    page: 1,
    pageSize: 10,
    hasMore: true,
  };

  async function callSearch(args: Record<string, unknown>) {
    const stub = { search: async () => page } as unknown as Basketeer;
    const client = await connect(stub);
    const res = (await client.callTool({
      name: "basketeer_search",
      arguments: args,
    })) as unknown as {
      isError?: boolean;
      content: [{ text: string }];
    };
    return { isError: res.isError, body: JSON.parse(res.content[0].text) };
  }

  it("projects each result and keeps the paging envelope", async () => {
    const { body } = await callSearch({ query: "milk", select: ["sku", "price.actual"] });
    expect(body).toEqual({
      results: [{ sku: "123", price: { actual: 1.2 } }],
      page: 1,
      pageSize: 10,
      hasMore: true,
    });
  });

  it("returns the full page when select is omitted", async () => {
    const { body } = await callSearch({ query: "milk" });
    expect(body).toEqual(page);
  });

  it("surfaces an unknown select field as a tool error naming valid fields", async () => {
    const { isError, body } = await callSearch({ query: "milk", select: ["cost"] });
    expect(isError).toBe(true);
    expect(body.message).toMatch(/unknown select field "cost".*price/);
  });
});

describe("order amend MCP tools", () => {
  type ToolResult = { isError?: boolean; content: [{ text: string }] };
  const basket = {
    id: "b1",
    guidePrice: 16.3,
    isInAmend: true,
    amendExpiry: "2026-10-30T23:46:00Z",
    shoppingMethod: "delivery",
    items: [{ id: "l1", sku: "111", quantity: 1, unit: "pcs", cost: 8.65, available: true }],
    raw: { huge: "blob" },
  };

  function stubOrders() {
    const calls: string[] = [];
    const orders = {
      amend: async (orderNo: string) => {
        calls.push(`amend:${orderNo}`);
        return { orderNo, get: async () => basket };
      },
      discardAmend: async (orderNo: string) => {
        calls.push(`discard:${orderNo}`);
      },
    };
    return { calls, stub: { orders } as unknown as Basketeer };
  }

  async function call(stub: Basketeer, name: string, args: Record<string, unknown>) {
    const client = await connect(stub);
    const res = (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
    return { isError: res.isError, body: JSON.parse(res.content[0].text) };
  }

  it("amend opens the order and returns its working basket without raw", async () => {
    const { calls, stub } = stubOrders();
    const { body } = await call(stub, "basketeer_orders_amend", { orderNo: "5931" });
    expect(calls).toEqual(["amend:5931"]);
    expect(body.amending).toBe("5931");
    expect(body.basket.isInAmend).toBe(true);
    expect(body.basket).not.toHaveProperty("raw");
  });

  it("discard needs the confirm token before calling the SDK", async () => {
    const { calls, stub } = stubOrders();
    const first = await call(stub, "basketeer_orders_amend_discard", { orderNo: "5931" });
    expect(first.body).toMatchObject({ requiresConfirmation: true, orderNo: "5931" });
    expect(calls).toEqual([]);

    const confirm = first.body.confirmToken;
    const second = await call(stub, "basketeer_orders_amend_discard", { orderNo: "5931", confirm });
    expect(second.body).toEqual({ ok: true, discarded: "5931" });
    expect(calls).toEqual(["discard:5931"]);
  });

  it("marks discard destructive and amend non-destructive", async () => {
    const client = await connect({ orders: {} } as unknown as Basketeer);
    const { tools } = await client.listTools();
    const hints = (name: string) => tools.find((t) => t.name === name)?.annotations;
    expect(hints("basketeer_orders_amend")).toMatchObject({ destructiveHint: false });
    expect(hints("basketeer_orders_amend_discard")).toMatchObject({ destructiveHint: true });
  });
});

describe("slot MCP tools", () => {
  type ToolResult = { isError?: boolean; content: [{ text: string }] };

  const slot: BookedSlot = {
    id: "slot-123",
    status: "Reserved",
    start: "2026-11-01T10:00:00Z",
    end: "2026-11-01T11:00:00Z",
    reservationExpiry: "2026-10-30T10:00:00Z",
    group: 1,
    locationUuid: null,
  };
  // The SDK result plus a nested `raw` blob, to check the tool output strips it.
  const booked = { ...slot, raw: { __typename: "FulfilmentType", huge: "blob" } };

  async function callSlotTool(name: string, slotId: string, slots: Record<string, unknown>) {
    const client = await connect({ slots } as unknown as Basketeer);
    const res = (await client.callTool({ name, arguments: { slotId } })) as unknown as ToolResult;
    return { isError: res.isError, body: JSON.parse(res.content[0].text) };
  }

  it("exposes book and release as destructive mutations", async () => {
    const client = await connect({ slots: {} } as unknown as Basketeer);
    const { tools } = await client.listTools();
    for (const name of ["basketeer_slots_book", "basketeer_slots_release"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
  });

  it("delegates booking with the exact slot ID and strips raw", async () => {
    const calls: string[] = [];
    const book = async (slotId: string) => {
      calls.push(slotId);
      return booked;
    };
    const { body } = await callSlotTool("basketeer_slots_book", "slot-123", { book });
    expect(calls).toEqual(["slot-123"]);
    expect(body).toEqual(slot);
  });

  it("delegates release with the exact slot ID and strips raw", async () => {
    const calls: string[] = [];
    const release = async (slotId: string) => {
      calls.push(slotId);
      return { ...booked, id: slotId };
    };
    const { body } = await callSlotTool("basketeer_slots_release", "slot-456", { release });
    expect(calls).toEqual(["slot-456"]);
    expect(body).toEqual({ ...slot, id: "slot-456" });
  });

  it("surfaces an SDK failure as a tool error", async () => {
    const book = async () => {
      throw new BasketeerError("Slot BOOK returned no slot");
    };
    const { isError, body } = await callSlotTool("basketeer_slots_book", "slot-123", { book });
    expect(isError).toBe(true);
    expect(body).toEqual({ error: "BasketeerError", message: "Slot BOOK returned no slot" });
  });

  it("rejects an empty slot ID without calling the SDK", async () => {
    const calls: string[] = [];
    const book = async (slotId: string) => {
      calls.push(slotId);
      return booked;
    };
    const client = await connect({ slots: { book } } as unknown as Basketeer);
    const res = (await client.callTool({
      name: "basketeer_slots_book",
      arguments: { slotId: "" },
    })) as unknown as ToolResult;
    expect(res.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("server instructions", () => {
  it("tell the model which storefront, currency and language it is on", async () => {
    const stub = { market: MARKETS.cz } as unknown as Basketeer;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await buildServer(stub).connect(serverTransport);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientTransport);
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("CZ");
    expect(instructions).toContain("CZK");
    expect(instructions).toContain("cs-CZ");
    expect(instructions).toContain("community-maintained");
    await client.close();
  });
});
