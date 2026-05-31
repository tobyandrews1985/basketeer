/**
 * End-to-end shop, up to (but NOT through) payment. Resume the harvested
 * session, fill a basket, list delivery slots, then hand back the checkout URL.
 * basketeer deliberately STOPS at the payment URL — a human finishes the
 * 3-D Secure card step in a browser. Run `npm run auth:login` first.
 *
 *   npx tsx examples/shop-flow.ts
 */
import { Basketeer, FileTokenStore } from "../src/index.js";
import { BrowserAuthBackend } from "../src/auth/browser/playwright.js";

async function main() {
  const t = await Basketeer.resume({
    store: new FileTokenStore(),
    authBackend: new BrowserAuthBackend(), // only used if the token needs refreshing
  });

  // Pick a couple of items — prefer "my usuals", fall back to a search.
  let picks = (await t.favourites({ limit: 2 })).results;
  if (picks.length < 2) picks = (await t.search("semi skimmed milk", { limit: 2 })).results;
  if (picks.length === 0) throw new Error("Nothing to add — no favourites and no search results.");

  console.log("Adding to basket:");
  for (const item of picks) {
    await t.basket.set(item.sku, 1); // exact quantity; basket.add(sku, n) increments
    console.log(`  + ${item.sku}  £${item.price.actual ?? "?"}  ${item.title}`);
  }

  const basket = await t.basket.get();
  console.log(`\nBasket ${basket.id ?? "(empty)"} — guide £${basket.guidePrice ?? 0}, ${basket.items.length} lines`);

  // Show available delivery slots (default window: today..+6 days).
  const slots = await t.slots.list();
  const available = slots.filter((s) => s.status === "Available");
  console.log(`\nDelivery slots available: ${available.length}/${slots.length}`);
  for (const s of available.slice(0, 5)) {
    console.log(`  ${s.id}  ${s.start} → ${s.end}  £${s.charge ?? 0}`);
  }
  // To reserve one: const booked = await t.slots.book(available[0].id);

  // Boundary: checkout() returns the basket + the URL where payment is completed.
  const { url } = await t.checkout();
  console.log(`\n💳 Checkout URL: ${url}`);
  console.log("   The SDK stops here by design — a human completes payment (3-D Secure) in a browser.");

  console.log("\n✅ Shop flow ready: basket filled, slots listed, payment handed off to the human.");
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
