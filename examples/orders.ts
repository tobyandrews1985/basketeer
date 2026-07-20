/**
 * Read your orders over pure HTTP: list upcoming orders, page through completed
 * order history, and inspect the last fulfilled order (its items, for a
 * "reorder my usual shop" flow). Amend and cancel are shown COMMENTED OUT —
 * this example never mutates an order. Run `npm run auth:login` first.
 *
 *   npx tsx examples/orders.ts
 */

import { BrowserAuthBackend } from "../src/auth/browser/playwright.js";
import { Basketeer, FileTokenStore } from "../src/index.js";

async function main() {
  const t = await Basketeer.resume({
    store: new FileTokenStore(),
    authBackend: new BrowserAuthBackend(), // only used if the token needs refreshing
  });

  // Upcoming (pending) orders, with slot + amend window.
  const upcoming = await t.orders.list();
  console.log(`Upcoming orders: ${upcoming.length}`);
  for (const o of upcoming) {
    const when = o.slot?.start ?? "?";
    const amend = o.isInAmend
      ? "in-amend"
      : o.amendExpiry
        ? `amend until ${o.amendExpiry}`
        : "locked";
    console.log(
      `  #${o.orderNo}  ${o.status}  ${o.totalItems ?? "?"} items  £${o.totalPrice ?? "?"}  slot ${when}  (${amend})`,
    );
  }

  // Completed orders, newest first. Offset-paged over a LIVE result set, so
  // dedupe by order.id and keep nextOffset only for the duration of this loop.
  console.log("\nOrder history (up to 3 pages):");
  const seen = new Set<string>();
  let pages = 0;
  for (let offset: number | null = 0; offset !== null && pages < 3; pages++) {
    const page = await t.orders.history({ offset, limit: 10 });
    for (const o of page.orders) {
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      console.log(`  #${o.orderNo}  ${o.status}  £${o.totalPrice ?? "?"}  ${o.slot?.start ?? "?"}`);
    }
    offset = page.nextOffset;
  }
  console.log(`History shown: ${seen.size} orders (first ${pages} page(s))`);

  // Last delivered order — its items are reorderable.
  const last = await t.orders.lastFulfilled();
  if (last) {
    console.log(
      `\nLast fulfilled order #${last.orderNo} — ${last.items.length} reorderable items:`,
    );
    for (const it of last.items) {
      console.log(`  ${it.productId ?? "?"}  x${it.quantity}${it.unit ?? ""}  ${it.title}`);
    }
    // Reorder by adding those items back to the basket:
    // for (const it of last.items) if (it.productId) await t.basket.add(it.productId, it.quantity);
  } else {
    console.log("\nNo fulfilled order on record.");
  }

  // --- Mutations (NOT executed here) ----------------------------------------
  // Open an order for amendment: returns a handle whose basket ops modify THIS
  // order until you check out again or discard it. Only before amendExpiry:
  //   const amendment = await t.orders.amend(orderNo);
  //   await amendment.set(sku, 2);   // edits apply to the amended order
  //   await amendment.discard();     // ...or leave the order unchanged
  // Cancel outright (before its cutoff):
  //   await t.orders.cancel(orderNo);

  console.log("\n✅ Orders read over pure HTTP (no order placed, paid, amended, or cancelled).");
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
