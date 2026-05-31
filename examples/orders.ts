/**
 * Read your orders over pure HTTP: list upcoming orders and inspect the last
 * fulfilled order (its items, for a "reorder my usual shop" flow). Amend and
 * cancel are shown COMMENTED OUT — this example never mutates an order.
 * Run `npm run auth:login` first.
 *
 *   npx tsx examples/orders.ts
 */
import { Basketeer, FileTokenStore } from "../src/index.js";
import { BrowserAuthBackend } from "../src/auth/browser/playwright.js";

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
    const amend = o.isInAmend ? "in-amend" : o.amendExpiry ? `amend until ${o.amendExpiry}` : "locked";
    console.log(`  #${o.orderNo}  ${o.status}  ${o.totalItems ?? "?"} items  £${o.totalPrice ?? "?"}  slot ${when}  (${amend})`);
  }

  // Last delivered order — its items are reorderable.
  const last = await t.orders.lastFulfilled();
  if (last) {
    console.log(`\nLast fulfilled order #${last.orderNo} — ${last.items.length} reorderable items:`);
    for (const it of last.items) {
      console.log(`  ${it.productId ?? "?"}  x${it.quantity}${it.unit ?? ""}  ${it.title}`);
    }
    // Reorder by adding those items back to the basket:
    // for (const it of last.items) if (it.productId) await t.basket.add(it.productId, it.quantity);
  } else {
    console.log("\nNo fulfilled order on record.");
  }

  // --- Mutations (NOT executed here) ----------------------------------------
  // Open an order for amendment (basket ops then modify THIS order until you
  // check out again or discard). Only before amendExpiry:
  //   await t.orders.amend(orderNo);
  //   await t.orders.discardAmendment(orderNo); // leave it unchanged
  // Cancel outright (before its cutoff):
  //   await t.orders.cancel(orderNo);

  console.log("\n✅ Orders read over pure HTTP (no order placed, paid, amended, or cancelled).");
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
