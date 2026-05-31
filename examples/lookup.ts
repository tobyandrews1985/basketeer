/**
 * Anonymous read demo — pure HTTP, no browser, no credentials.
 *   npm run example:lookup
 */
import { Basketeer } from "../src/index.js";

async function main() {
  const t = new Basketeer(); // anonymous; default 1 req/s throttle

  console.log("Search('semi skimmed milk'):");
  const { results } = await t.search("semi skimmed milk", { limit: 5 });
  for (const r of results) {
    console.log(`  ${r.sku}  £${r.price.actual}  ${r.title}${r.onOffer ? "  [offer]" : ""}`);
  }

  const first = results[0];
  if (!first) return;
  console.log(`\nGetProduct('${first.sku}'):`);
  const p = await t.getProduct(first.sku);
  console.log(`  ${p.title}`);
  console.log(
    `  brand=${p.brand}  £${p.price.actual} (${p.price.unitPrice}/${p.price.unitOfMeasure})`,
  );
  console.log(`  packSize=${p.packSize ? `${p.packSize.value}${p.packSize.units}` : "n/a"}`);
  console.log(
    `  promotions=${p.promotions.length}  nutritionMicros=${p.nutrition?.micros.length ?? 0}`,
  );

  console.log("\n✅ Real Basketeer — pure-HTTP anonymous reads working.");
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
