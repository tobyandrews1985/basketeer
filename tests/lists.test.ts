import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { Basketeer } from "../src/client.js";
import { BasketeerError, NotFoundError } from "../src/errors.js";
import { MARKETS } from "../src/market.js";
import { buildServer, confirmToken } from "../src/mcp-server.js";
import { mergeShoppingListItems, parseShoppingList, parseShoppingLists } from "../src/parsers.js";
import { gqlString } from "../src/queries.js";
import { SESSION, stubFetch } from "./helpers.js";

// Obviously fake ids — never real list ids or TPNBs.
const LIST_ID = "list-0000-test";

const LISTS_BODY = [
  {
    data: {
      getShoppingLists: {
        shoppingLists: [
          { id: LIST_ID, name: "Default list" },
          { id: "list-0001-test", name: "Party" },
          null,
          { name: "no id" },
        ],
      },
    },
  },
];

function listBody(key: string, items: unknown[], extra: Record<string, unknown> = {}) {
  return [{ data: { [key]: { id: LIST_ID, ...extra, items } } }];
}

function client(responses: { body: unknown }[]) {
  const { impl, calls } = stubFetch(responses);
  return { t: new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl }), calls };
}

describe("shopping list parsers", () => {
  it("parseShoppingLists keeps entries with an id and tolerates junk", () => {
    expect(parseShoppingLists(LISTS_BODY[0]!.data.getShoppingLists)).toEqual([
      { id: LIST_ID, name: "Default list" },
      { id: "list-0001-test", name: "Party" },
    ]);
    expect(parseShoppingLists(null)).toEqual([]);
    expect(parseShoppingLists({ shoppingLists: null })).toEqual([]);
  });

  it("parseShoppingList maps item id → tpnb and keeps a null checked", () => {
    const list = parseShoppingList({
      id: LIST_ID,
      name: "Default list",
      items: [
        { id: "100000001", quantity: 2, checked: false },
        { id: 100000002, quantity: 1, checked: null },
        { id: "100000003", quantity: null, checked: true },
        { quantity: 9 },
        null,
      ],
    });
    expect(list.id).toBe(LIST_ID);
    expect(list.name).toBe("Default list");
    expect(list.items).toEqual([
      { tpnb: "100000001", quantity: 2, checked: false },
      { tpnb: "100000002", quantity: 1, checked: null },
      { tpnb: "100000003", quantity: 0, checked: true },
    ]);
  });

  it("parseShoppingList reports a missing name as null", () => {
    expect(parseShoppingList({ id: LIST_ID, items: [] }).name).toBeNull();
  });
});

describe("mergeShoppingListItems", () => {
  const current = [
    { tpnb: "100000001", quantity: 2, checked: false },
    { tpnb: "100000002", quantity: 3, checked: true },
    { tpnb: "100000003", quantity: 1, checked: null },
  ];

  it("keeps every current item untouched when nothing is added", () => {
    expect(mergeShoppingListItems(current, [])).toEqual([
      { tpnb: "100000001", quantity: 2, checked: false },
      { tpnb: "100000002", quantity: 3, checked: true },
      { tpnb: "100000003", quantity: 1, checked: false },
    ]);
  });

  it("increments unticked items, resets ticked ones, appends new ones", () => {
    const merged = mergeShoppingListItems(current, [
      { tpnb: "100000001", quantity: 1 },
      { tpnb: "100000002", quantity: 1 },
      { tpnb: "100000003", quantity: 2 },
      { tpnb: "100000004", quantity: 0.5 },
    ]);
    expect(merged).toEqual([
      { tpnb: "100000001", quantity: 3, checked: false },
      { tpnb: "100000002", quantity: 1, checked: false },
      { tpnb: "100000003", quantity: 3, checked: false },
      { tpnb: "100000004", quantity: 0.5, checked: false },
    ]);
  });

  it("accumulates duplicate additions", () => {
    expect(
      mergeShoppingListItems(
        [],
        [
          { tpnb: "100000009", quantity: 1 },
          { tpnb: "100000009", quantity: 2 },
        ],
      ),
    ).toEqual([{ tpnb: "100000009", quantity: 3, checked: false }]);
  });
});

describe("gqlString", () => {
  it("escapes quotes and backslashes so values cannot break out of the literal", () => {
    expect(gqlString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(gqlString('x") { id } y: q("')).toBe('"x\\") { id } y: q(\\""');
  });
});

describe("lists.get", () => {
  it("sends getShoppingLists (never plain shoppingLists) with INSTORE by default", async () => {
    const { t, calls } = client([{ body: LISTS_BODY }]);
    const lists = await t.lists.get();
    const op = calls[0]!.body[0];
    expect(op.operationName).toBe("GetShoppingLists");
    expect(op.extensions.mfeName).toBe("mfe-orchestrator");
    expect(op.query).toContain("getShoppingLists(listType: INSTORE)");
    expect(lists.map((l) => l.name)).toEqual(["Default list", "Party"]);
  });

  it("passes optional store and paging arguments", async () => {
    const { t, calls } = client([{ body: LISTS_BODY }]);
    await t.lists.get("CUSTOM", { locationUuid: "loc-test", page: 2, limit: 5, offset: 0 });
    expect(calls[0]!.body[0].query).toContain(
      'getShoppingLists(listType: CUSTOM, locationUuid: "loc-test", page: 2, limit: 5, offset: 0)',
    );
  });

  it("rejects an unknown list type before any request", async () => {
    const { t, calls } = client([{ body: LISTS_BODY }]);
    await expect(t.lists.get("WISHLIST" as never)).rejects.toThrow(RangeError);
    await expect(t.lists.get("INSTORE", { limit: 0 })).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
});

describe("lists.read", () => {
  it("reads shoppingList(listType, listId) into a typed list", async () => {
    const body = listBody("shoppingList", [{ id: "100000001", quantity: 2, checked: false }], {
      name: "Default list",
    });
    const { t, calls } = client([{ body }]);
    const list = await t.lists.read(LIST_ID);
    expect(calls[0]!.body[0].query).toContain(
      `shoppingList(listType: INSTORE, listId: "${LIST_ID}") { id name items { id quantity checked } }`,
    );
    expect(list).toMatchObject({
      id: LIST_ID,
      name: "Default list",
      items: [{ tpnb: "100000001", quantity: 2, checked: false }],
    });
  });

  it("throws NotFoundError when Tesco returns no list", async () => {
    const { t } = client([{ body: [{ data: { shoppingList: null } }] }]);
    await expect(t.lists.read(LIST_ID)).rejects.toThrow(NotFoundError);
  });
});

describe("lists.setItems", () => {
  it("sends the whole list as inline listItems, defaulting checked to false", async () => {
    const body = listBody("updateShoppingListItem", [
      { id: "100000001", quantity: 2, checked: false },
      { id: "100000002", quantity: 1.5, checked: true },
    ]);
    const { t, calls } = client([{ body }]);
    const list = await t.lists.setItems(LIST_ID, [
      { tpnb: "100000001", quantity: 2 },
      { tpnb: "100000002", quantity: 1.5, checked: true },
    ]);
    const op = calls[0]!.body[0];
    expect(op.operationName).toBe("UpdateShoppingListItem");
    expect(op.query).toContain(
      `updateShoppingListItem(listType: INSTORE, listId: "${LIST_ID}", listItems: [` +
        '{ tpnb: "100000001", quantity: 2, checked: false }, ' +
        '{ tpnb: "100000002", quantity: 1.5, checked: true }])',
    );
    expect(list.items).toHaveLength(2);
  });

  it("an empty array is sent as-is (it clears the list)", async () => {
    const { t, calls } = client([{ body: listBody("updateShoppingListItem", []) }]);
    await t.lists.setItems(LIST_ID, []);
    expect(calls[0]!.body[0].query).toContain("listItems: []");
  });

  it("rejects bad quantities and empty TPNBs before any request", async () => {
    const { t, calls } = client([{ body: listBody("updateShoppingListItem", []) }]);
    for (const quantity of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(t.lists.setItems(LIST_ID, [{ tpnb: "100000001", quantity }])).rejects.toThrow(
        RangeError,
      );
    }
    await expect(t.lists.setItems(LIST_ID, [{ tpnb: " ", quantity: 1 }])).rejects.toThrow(
      RangeError,
    );
    await expect(t.lists.setItems("", [])).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
});

describe("lists.addItems", () => {
  it("reads, merges, and writes back the existing items plus the additions", async () => {
    const { t, calls } = client([
      {
        body: listBody("shoppingList", [
          { id: "100000001", quantity: 2, checked: false },
          { id: "100000002", quantity: 1, checked: true },
          { id: "100000003", quantity: 1, checked: null },
        ]),
      },
      { body: listBody("updateShoppingListItem", []) },
    ]);
    await t.lists.addItems(LIST_ID, [
      { tpnb: "100000001", quantity: 1 },
      { tpnb: "100000002", quantity: 4 },
      { tpnb: "100000005", quantity: 1 },
    ]);
    expect(calls.map((c) => c.body[0].operationName)).toEqual([
      "GetShoppingList",
      "UpdateShoppingListItem",
    ]);
    expect(calls[1]!.body[0].query).toContain(
      "listItems: [" +
        '{ tpnb: "100000001", quantity: 3, checked: false }, ' +
        '{ tpnb: "100000002", quantity: 4, checked: false }, ' +
        '{ tpnb: "100000003", quantity: 1, checked: false }, ' +
        '{ tpnb: "100000005", quantity: 1, checked: false }]',
    );
  });

  it("never writes when the read finds no list (would wipe it)", async () => {
    const { t, calls } = client([
      { body: [{ data: { shoppingList: null } }] },
      { body: listBody("updateShoppingListItem", []) },
    ]);
    await expect(t.lists.addItems(LIST_ID, [{ tpnb: "100000001", quantity: 1 }])).rejects.toThrow(
      NotFoundError,
    );
    expect(calls).toHaveLength(1);
  });

  it("never writes when the read fails", async () => {
    const { t, calls } = client([
      { body: [{ errors: [{ message: "vnd.tesco.product-list.internal.error" }] }] },
      { body: listBody("updateShoppingListItem", []) },
    ]);
    await expect(t.lists.addItems(LIST_ID, [{ tpnb: "100000001", quantity: 1 }])).rejects.toThrow(
      BasketeerError,
    );
    expect(calls).toHaveLength(1);
  });

  it("validates additions before reading", async () => {
    const { t, calls } = client([{ body: listBody("shoppingList", []) }]);
    await expect(t.lists.addItems(LIST_ID, [{ tpnb: "100000001", quantity: 0 }])).rejects.toThrow(
      RangeError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("lists.create / lists.rename", () => {
  it("create sends createShoppingList with an escaped name", async () => {
    const { t, calls } = client([
      {
        body: [
          { data: { createShoppingList: { id: LIST_ID, name: 'Mum\'s "big" shop', items: [] } } },
        ],
      },
    ]);
    const list = await t.lists.create('Mum\'s "big" shop');
    expect(calls[0]!.body[0].query).toContain(
      'createShoppingList(listType: INSTORE, name: "Mum\'s \\"big\\" shop") { id name items { id } }',
    );
    expect(list).toMatchObject({ id: LIST_ID, name: 'Mum\'s "big" shop', items: [] });
  });

  it("create surfaces Tesco's duplicate-name rejection", async () => {
    const { t } = client([
      {
        body: [
          {
            errors: [{ message: "Bad Request: List name duplicated" }],
            data: { createShoppingList: null },
          },
        ],
      },
    ]);
    await expect(t.lists.create("Default list")).rejects.toThrow(/List name duplicated/);
  });

  it("rename sends updateShoppingList and returns { id, name }", async () => {
    const { t, calls } = client([
      { body: [{ data: { updateShoppingList: { id: LIST_ID, name: "Weekly" } } }] },
    ]);
    expect(await t.lists.rename(LIST_ID, "Weekly", "CUSTOM")).toEqual({
      id: LIST_ID,
      name: "Weekly",
    });
    expect(calls[0]!.body[0].query).toContain(
      `updateShoppingList(listType: CUSTOM, listId: "${LIST_ID}", name: "Weekly") { id name }`,
    );
  });

  it("does not expose a delete", () => {
    const { t } = client([{ body: [] }]);
    expect(Object.keys(t.lists).sort()).toEqual(
      ["addItems", "create", "get", "read", "rename", "setItems"].sort(),
    );
  });
});

describe("MCP list tools", () => {
  const current = { id: LIST_ID, name: "Default list", items: [], raw: { huge: "blob" } };

  async function connect() {
    const writes: unknown[] = [];
    const stub = {
      market: MARKETS.uk,
      lists: {
        read: async () => current,
        setItems: async (_id: string, items: unknown) => {
          writes.push(items);
          return current;
        },
      },
    } as unknown as Basketeer;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await buildServer(stub).connect(serverTransport);
    const mcp = new Client({ name: "test", version: "0.0.0" });
    await mcp.connect(clientTransport);
    const call = async (args: Record<string, unknown>) => {
      const res = (await mcp.callTool({
        name: "basketeer_list_set_items",
        arguments: args,
      })) as unknown as { content: [{ text: string }] };
      return JSON.parse(res.content[0].text);
    };
    return { call, writes };
  }

  it("basketeer_list_set_items needs a confirmToken before replacing the list", async () => {
    const { call, writes } = await connect();
    const items = [{ tpnb: "100000001", quantity: 1 }];
    const first = await call({ listId: LIST_ID, items });
    expect(first.requiresConfirmation).toBe(true);
    expect(first.current).toMatchObject({ id: LIST_ID });
    expect(first.current.raw).toBeUndefined();
    expect(first.confirmToken).toBe(confirmToken(`list-set:${LIST_ID}:${JSON.stringify(items)}`));
    expect(writes).toHaveLength(0);

    await call({ listId: LIST_ID, items, confirm: first.confirmToken });
    expect(writes).toEqual([items]);
  });
});
