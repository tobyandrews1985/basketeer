import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { Basketeer } from "../src/index.js";
import { buildServer, confirmToken } from "../src/mcp-server.js";

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
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await buildServer(stub).connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);
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
