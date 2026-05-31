import type { AuthBackend } from "./auth/types.js";
import type { AuthHeaders } from "./graphql.js";
import { jwtExpiryMs } from "./jwt.js";
import type { Session } from "./models.js";
import type { TokenStore } from "./store/types.js";

export interface SessionManagerOptions {
  session?: Session | null;
  backend?: AuthBackend;
  store?: TokenStore;
}

/**
 * Owns the auth lifecycle: holds the current {@link Session}, serialises it
 * into request headers, and renews it on demand (proactively or lazily on a
 * 401) via the {@link AuthBackend}, persisting through the {@link TokenStore}.
 */
export class SessionManager {
  private session: Session | null;
  private readonly backend?: AuthBackend;
  private readonly store?: TokenStore;

  constructor(opts: SessionManagerOptions = {}) {
    this.session = opts.session ?? null;
    this.backend = opts.backend;
    this.store = opts.store;
  }

  /** Load any persisted session from the store into the manager. */
  async load(): Promise<Session | null> {
    if (this.store) this.session = await this.store.load();
    return this.session;
  }

  get current(): Session | null {
    return this.session;
  }

  async setSession(session: Session): Promise<void> {
    // Clone so we never mutate the caller's object (it may be shared/frozen).
    const stored: Session = {
      ...session,
      accessTokenExpiry: session.accessTokenExpiry ?? jwtExpiryMs(session.accessToken),
    };
    this.session = stored;
    if (this.store) await this.store.save(stored);
  }

  /** True when there is no session or the access token is within `skewMs` of expiry. */
  isExpired(skewMs = 60_000): boolean {
    if (!this.session) return true;
    const exp = this.session.accessTokenExpiry;
    return exp !== undefined && Date.now() >= exp - skewMs;
  }

  /** Build the auth headers for a write, or undefined when anonymous. */
  authHeaders(): AuthHeaders | undefined {
    if (!this.session) return undefined;
    const cookie = Object.entries(this.session.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    return {
      authorization: `Bearer ${this.session.accessToken}`,
      customerUuid: this.session.customerUuid,
      cookie: cookie || undefined,
    };
  }

  /** Renew via the backend. Returns false if renewal is impossible. */
  async refresh(): Promise<boolean> {
    if (!this.backend || !this.session) return false;
    const renewed = await this.backend.refresh(this.session);
    await this.setSession(renewed);
    return true;
  }

  async login(...args: Parameters<AuthBackend["login"]>): Promise<Session> {
    if (!this.backend) throw new Error("No AuthBackend configured — cannot login.");
    const session = await this.backend.login(...args);
    await this.setSession(session);
    return session;
  }
}
