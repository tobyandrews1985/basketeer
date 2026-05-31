/**
 * Bring your own auth — the un-opinionated path.
 *
 * basketeer hosts nothing and hard-depends on no browser. It only needs a
 * `Session` ({ accessToken, customerUuid, cookies }). HOW you mint and store
 * that session is entirely yours. This file shows the three injection points.
 *
 *   npx tsx examples/bring-your-own-auth.ts        # runs demo #1 (anonymous-safe)
 *
 * (In your app: `import { ... } from "basketeer"`. This repo example imports
 *  from ../src so it runs without a published build.)
 */
import { Basketeer, sessionFromCookies } from "../src/index.js";
import type { AuthBackend, Credentials, Session, TokenStore } from "../src/index.js";

// ─── 1) Inject a session you obtained however you like ──────────────────────
// Got cookies from your own browser farm, a manual harvest, a teammate's
// machine? Turn the cookie list into a Session and hand it straight in.
function clientFromHarvestedCookies(cookies: { name: string; value: string }[]) {
  const session = sessionFromCookies(cookies); // keeps only the cookies that matter
  return new Basketeer({ session }); // reads + writes, pure HTTP, zero browser here
}

// Or if you already have the raw values, skip the helper entirely:
function clientFromRawSession(session: Session) {
  return new Basketeer({ session });
}

// ─── 2) Your own AuthBackend (where the browser/credentials live is YOUR call)
// The interface is two methods. Mint a session in login(), renew in refresh().
// Here: load it from your own secret store (Vault, Convex, env, …).
class MySecretStoreAuthBackend implements AuthBackend {
  async login(_credentials?: Credentials): Promise<Session> {
    const cookies = await loadCookiesFromMySecretStore(); // your code
    return sessionFromCookies(cookies);
  }
  async refresh(_session: Session): Promise<Session> {
    // however you renew — re-read a freshly-rotated jar, drive a hosted browser, etc.
    const cookies = await loadCookiesFromMySecretStore();
    return sessionFromCookies(cookies);
  }
}

// ─── 3) Your own TokenStore (where the session is persisted is YOUR call) ────
// Two methods + clear. Back it with Redis, a DB, Convex, a file — anything.
class KvTokenStore implements TokenStore {
  constructor(private kv: Map<string, string>, private key = "tesco-session") {}
  async load(): Promise<Session | null> {
    const raw = this.kv.get(this.key);
    return raw ? (JSON.parse(raw) as Session) : null;
  }
  async save(session: Session): Promise<void> {
    this.kv.set(this.key, JSON.stringify(session));
  }
  async clear(): Promise<void> {
    this.kv.delete(this.key);
  }
}

// Wire them together — the library auto-refreshes via your backend and persists
// via your store; the data plane stays pure HTTP everywhere.
async function wireItUp() {
  const client = await Basketeer.resume({
    store: new KvTokenStore(new Map()),
    authBackend: new MySecretStoreAuthBackend(),
  });
  return client;
}

// ─── Runnable bit: the anonymous read path needs none of the above ──────────
async function main() {
  void clientFromHarvestedCookies;
  void clientFromRawSession;
  void wireItUp;

  const t = new Basketeer(); // no session, no backend, no store
  const { results } = await t.search("oat milk", { limit: 1 });
  const first = results[0];
  console.log(`anonymous read works with zero auth wiring: ${first?.sku} ${first?.title}`);
  console.log("→ add a Session (any of the 3 ways above) to unlock basket/slots.");
}

// Stub — replace with your real secret retrieval.
async function loadCookiesFromMySecretStore(): Promise<{ name: string; value: string }[]> {
  throw new Error("implement me: return your harvested Tesco cookies");
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
