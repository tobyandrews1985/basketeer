/**
 * One-time interactive login. Opens a real Chrome, you sign in, and the
 * authenticated session (bearer + customer-uuid + Tesco cookies) is harvested
 * and saved to ~/.basketeer/session.json. Everything after this is pure HTTP.
 *
 *   npx playwright install chromium   # once, if 'chrome' channel is unavailable
 *   npm run auth:login
 */

import { BrowserAuthBackend } from "../src/auth/browser/playwright.js";
import { Basketeer, FileTokenStore } from "../src/index.js";

async function main() {
  const store = new FileTokenStore();
  const t = new Basketeer({ store, authBackend: new BrowserAuthBackend() });
  const session = await t.login();
  console.log(`\n✅ Session harvested and saved.`);
  console.log(`   customer-uuid: ${session.customerUuid}`);
  console.log(`   cookies kept:  ${Object.keys(session.cookies).join(", ")}`);
  console.log(
    `   token expiry:  ${session.accessTokenExpiry ? new Date(session.accessTokenExpiry).toISOString() : "unknown"}`,
  );
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
