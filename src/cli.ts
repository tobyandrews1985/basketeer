#!/usr/bin/env node

/**
 * `basketeer` — a thin CLI over the basketeer SDK.
 *
 * Reads work anonymously; writes (basket / slots / orders / checkout) resume a
 * persisted session via {@link FileTokenStore} and, for `login`, mint one with
 * {@link BrowserAuthBackend}. Results print as JSON to stdout; coded errors go
 * to stderr with a non-zero exit. Per the SDK's ethics ceiling, `checkout` only
 * hands back a payment URL — a human completes payment in a browser.
 */

import { Command, InvalidArgumentError } from "commander";
import { BrowserAuthBackend } from "./auth/browser/playwright.js";
import type { NutritionFilter } from "./index.js";
import { Basketeer, BasketeerError, FileTokenStore } from "./index.js";
import { isMainModule } from "./is-main.js";

/** Pretty-print any JSON-serialisable value to stdout. */
function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** commander parser: a non-negative integer, else a usage error. */
export function nonNegativeInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0)
    throw new InvalidArgumentError("must be a non-negative integer");
  return n;
}

/** commander parser: a non-negative number (decimals allowed), else a usage error. */
export function nonNegativeNumber(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new InvalidArgumentError("must be a non-negative number");
  return n;
}

const store = new FileTokenStore();

/** Resume a persisted session for authenticated commands (refreshing if able). */
function authedClient(): Promise<Basketeer> {
  return Basketeer.resume({ store, authBackend: new BrowserAuthBackend() });
}

/** Anonymous client for read-only commands (no session required). */
function readClient(): Basketeer {
  return new Basketeer();
}

const program = new Command();
program
  .name("basketeer")
  .description("Typed CLI for Tesco grocery automation (basketeer).")
  .showHelpAfterError();

// --- auth -------------------------------------------------------------------

program
  .command("login")
  .description("Open a real Chrome to sign in, then persist the harvested session.")
  .action(async () => {
    const client = new Basketeer({ store, authBackend: new BrowserAuthBackend() });
    const session = await client.login();
    emit({
      ok: true,
      customerUuid: session.customerUuid,
      expiresAt: session.accessTokenExpiry ?? null,
    });
  });

// --- reads (anonymous) ------------------------------------------------------

program
  .command("search")
  .description("Search the catalogue.")
  .argument("<query>", "search terms")
  .option("--limit <n>", "max results", nonNegativeInt, 10)
  .option(
    "--min-protein <g>",
    "only products with at least this protein per 100g/ml",
    nonNegativeNumber,
  )
  .option("--max-sugar <g>", "only products with at most this sugar per 100g/ml", nonNegativeNumber)
  .option("--sort <field>", "sort hydrated results by a macro (e.g. protein)")
  .option("--hydrate <n>", "max results to fetch nutrition for (default 20)", nonNegativeInt)
  .action(
    async (
      query: string,
      opts: {
        limit: number;
        minProtein?: number;
        maxSugar?: number;
        sort?: string;
        hydrate?: number;
      },
    ) => {
      const usesNutrition = opts.minProtein != null || opts.maxSugar != null || opts.sort != null;
      if (usesNutrition) {
        const where: NutritionFilter = {};
        if (opts.minProtein != null) where.protein = { min: opts.minProtein };
        if (opts.maxSugar != null) where.sugars = { max: opts.maxSugar };
        const sort = opts.sort ? { by: opts.sort, dir: "desc" as const } : undefined;
        emit(
          await readClient().searchByNutrition(query, {
            where,
            sort,
            hydrate: opts.hydrate,
            limit: opts.limit,
          }),
        );
        return;
      }
      emit(await readClient().search(query, { limit: opts.limit }));
    },
  );

program
  .command("product")
  .description("Look up a single product by SKU (tpnc).")
  .argument("<sku>", "product SKU / tpnc")
  .action(async (sku: string) => {
    emit(await readClient().getProduct(sku));
  });

program
  .command("nutrition")
  .argument("<sku>", "product SKU (tpnc)")
  .description("Print normalized nutrition (macros + micros) for a product.")
  .action(async (sku: string) => {
    emit((await readClient().getProduct(sku)).nutrition);
  });

program
  .command("favourites")
  .description("List the customer's favourites (requires a session).")
  .option("--limit <n>", "max results", nonNegativeInt, 50)
  .action(async (opts: { limit: number }) => {
    const client = await authedClient();
    emit(await client.favourites({ limit: opts.limit }));
  });

// --- basket -----------------------------------------------------------------

const basket = program.command("basket").description("Inspect and edit the basket.");

basket
  .command("get")
  .description("Show the current basket.")
  .action(async () => {
    const client = await authedClient();
    emit(await client.basket.get());
  });

basket
  .command("add")
  .description("Add <qty> (default 1) of a product to the basket (increments the line).")
  .argument("<sku>", "product SKU / tpnc")
  .argument("[qty]", "quantity to add", nonNegativeInt, 1)
  .action(async (sku: string, qty: number) => {
    const client = await authedClient();
    emit(await client.basket.add(sku, qty));
  });

basket
  .command("set")
  .description("Set a basket line to an exact quantity (0 removes it).")
  .argument("<sku>", "product SKU / tpnc")
  .argument("<qty>", "exact quantity", nonNegativeInt)
  .action(async (sku: string, qty: number) => {
    const client = await authedClient();
    emit(await client.basket.set(sku, qty));
  });

basket
  .command("remove")
  .description("Remove a line from the basket.")
  .argument("<sku>", "product SKU / tpnc")
  .action(async (sku: string) => {
    const client = await authedClient();
    emit(await client.basket.remove(sku));
  });

// --- slots ------------------------------------------------------------------

program
  .command("slots")
  .description("List delivery slots (or collection slots with --collection).")
  .option("--collection", "list click-and-collect slots instead of delivery")
  .action(async (opts: { collection?: boolean }) => {
    const client = await authedClient();
    emit(opts.collection ? await client.slots.listCollection() : await client.slots.list());
  });

// --- orders -----------------------------------------------------------------

const orders = program.command("orders").description("Inspect and manage orders.");

orders
  .command("list")
  .description("List upcoming orders.")
  .action(async () => {
    const client = await authedClient();
    emit(await client.orders.list());
  });

orders
  .command("cancel")
  .description("Cancel an order by order number.")
  .argument("<orderNo>", "order number")
  .action(async (orderNo: string) => {
    const client = await authedClient();
    await client.orders.cancel(orderNo);
    emit({ ok: true, cancelled: orderNo });
  });

orders
  .command("reorder")
  .description("Re-add the last delivered order's items to the basket.")
  .action(async () => {
    const client = await authedClient();
    const last = await client.orders.lastFulfilled();
    if (!last) {
      emit({ ok: false, reason: "no previous fulfilled order" });
      return;
    }
    const items = last.items
      .filter((it) => it.productId)
      .map((it) => ({ id: it.productId!, newValue: it.quantity, newUnitChoice: it.unit ?? "pcs" }));
    const { basket, rejected, unavailable } = await client.basket.update(items);
    emit({
      ok: !rejected.length && !unavailable.length,
      reorderedFrom: last.orderNo,
      lines: items.length,
      rejected,
      unavailable,
      basket,
    });
  });

// --- checkout ---------------------------------------------------------------

program
  .command("checkout")
  .description("Prepare checkout and print the payment URL (a human completes payment).")
  .action(async () => {
    const client = await authedClient();
    const { basket: cart, url } = await client.checkout();
    emit({
      basket: cart,
      paymentUrl: url,
      note: "Payment is browser-bound (3-D Secure). Open paymentUrl and complete payment yourself — the CLI never pays.",
    });
  });

// --- entrypoint -------------------------------------------------------------

// Only parse argv when run as a binary, so the module is importable (tests).
if (isMainModule(import.meta.url)) {
  program.parseAsync().catch((err: unknown) => {
    const name = err instanceof BasketeerError ? err.name : "Error";
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${name}: ${message}\n`);
    process.exit(1);
  });
}
