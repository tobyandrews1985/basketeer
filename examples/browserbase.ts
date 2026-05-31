/**
 * Browserbase AuthBackend — reference recipe for SERVERLESS consumers.
 *
 * The data plane is pure HTTP and runs in any serverless runtime. Only the
 * occasional login/refresh needs a real browser — and a serverless function
 * can't hold one, so we offload it to Browserbase (a hosted real-browser API).
 * Akamai sees a genuine browser; we harvest the session and everything else is
 * `fetch`.
 *
 * This is a COPY-PASTE RECIPE, deliberately kept OUT of the library so
 * basketeer takes no Browserbase dependency. It uses Playwright's CDP
 * connect + Browserbase's REST API. Verify endpoints against the current
 * Browserbase docs — this is not covered by the repo's tests.
 *
 * Needs: BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID, and (peer) `playwright`.
 * Persist `backend.contextId` between login and refresh so the logged-in cookies
 * survive (Browserbase "contexts" persist a profile across ephemeral sessions).
 *
 * In your app: `import { sessionFromCookies } from "basketeer"`.
 */
import { chromium } from "playwright";
import { sessionFromCookies } from "../src/index.js";
import type { AuthBackend, Credentials, Session } from "../src/index.js";

const BB_API = "https://api.browserbase.com/v1";
const LOGIN_URL = "https://www.tesco.com/account/login";
const REFRESH_URL =
  "https://www.tesco.com/account/auth/en-GB/refresh-token?soft-refresh=false" +
  "&from=https%3A%2F%2Fwww.tesco.com%2Fshop%2Fen-GB%2Flanding%2Fgroceries";

export interface BrowserbaseAuthOptions {
  apiKey: string;
  projectId: string;
  /** Reuse a persisted context across login → refresh. Created on first login. */
  contextId?: string;
  /**
   * Called during login() with the Browserbase live-view URL. Surface it to
   * your end user (iframe / new tab) so THEY type their Tesco credentials + 2FA.
   * You never see or store their password.
   */
  onLoginUrl: (liveViewUrl: string) => void | Promise<void>;
  /** How long to wait for the user to finish logging in (ms). Default 5 min. */
  loginTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class BrowserbaseAuthBackend implements AuthBackend {
  contextId?: string;
  private readonly opts: BrowserbaseAuthOptions;

  constructor(opts: BrowserbaseAuthOptions) {
    this.opts = opts;
    this.contextId = opts.contextId;
  }

  private async api(path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${BB_API}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "X-BB-API-Key": this.opts.apiKey, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Browserbase ${path} → ${res.status}: ${await res.text()}`);
    return res.json();
  }

  private async ensureContext(): Promise<string> {
    if (this.contextId) return this.contextId;
    const ctx = await this.api("/contexts", { projectId: this.opts.projectId });
    this.contextId = ctx.id; // persist this in your store for future refreshes
    return ctx.id;
  }

  /** Open a Browserbase browser, surface the live view so the user logs in, harvest. */
  async login(_credentials?: Credentials): Promise<Session> {
    const contextId = await this.ensureContext();
    const session = await this.api("/sessions", {
      projectId: this.opts.projectId,
      keepAlive: true,
      browserSettings: { context: { id: contextId, persist: true } },
    });
    const browser = await chromium.connectOverCDP(session.connectUrl);
    try {
      const ctx = browser.contexts()[0]!;
      const page = ctx.pages()[0] ?? (await ctx.newPage());

      const debug = await this.api(`/sessions/${session.id}/debug`);
      await this.opts.onLoginUrl(debug.debuggerFullscreenUrl ?? debug.debuggerUrl);

      await page.goto(LOGIN_URL);
      // Wait (in the user's hands) until the auth cookies appear.
      const deadline = Date.now() + (this.opts.loginTimeoutMs ?? 300_000);
      while (Date.now() < deadline) {
        if ((await ctx.cookies()).some((c) => c.name === "OAuth.AccessToken")) break;
        await sleep(2000);
      }
      return sessionFromCookies(await ctx.cookies());
    } finally {
      await browser.close().catch(() => {});
    }
  }

  /** Reuse the persisted context, force a token rotation, harvest the new session. */
  async refresh(_session: Session): Promise<Session> {
    const contextId = await this.ensureContext();
    const session = await this.api("/sessions", {
      projectId: this.opts.projectId,
      browserSettings: { context: { id: contextId, persist: true } },
    });
    const browser = await chromium.connectOverCDP(session.connectUrl);
    try {
      const ctx = browser.contexts()[0]!;
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      const before = (await ctx.cookies()).find((c) => c.name === "OAuth.AccessToken")?.value;
      await page.goto(REFRESH_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      for (let i = 0; i < 20; i++) {
        const tok = (await ctx.cookies()).find((c) => c.name === "OAuth.AccessToken")?.value;
        if (tok && tok !== before && !page.url().split("?")[0]!.includes("/account/auth")) break;
        await sleep(1000);
      }
      return sessionFromCookies(await ctx.cookies());
    } finally {
      await browser.close().catch(() => {});
    }
  }
}

// Example wiring (pseudo): the data plane is pure HTTP; the browser only fires
// inside the backend, on Browserbase, not in your function's runtime.
//
//   import { Basketeer } from "basketeer";
//   const backend = new BrowserbaseAuthBackend({
//     apiKey: process.env.BROWSERBASE_API_KEY!,
//     projectId: process.env.BROWSERBASE_PROJECT_ID!,
//     contextId: await store.loadContextId(),         // persist across runs
//     onLoginUrl: (url) => notifyUser(`Connect Tesco: ${url}`),
//   });
//   const tesco = new Basketeer({ authBackend: backend, store: myConvexTokenStore });
//   await tesco.login();                  // user logs in via the live view (once)
//   await store.saveContextId(backend.contextId!);
//   // ...later, anywhere, pure HTTP:
//   await (await Basketeer.resume({ authBackend: backend, store: myConvexTokenStore })).basket.get();
