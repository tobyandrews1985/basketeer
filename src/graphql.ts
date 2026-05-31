import { randomUUID } from "node:crypto";
import { ApiKeyError, AuthExpiredError, GraphQLRequestError, RateLimitedError } from "./errors.js";
import { ENDPOINT, PUBLIC_API_KEY } from "./operations.js";

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

/** Auth material injected on writes. Undefined for anonymous reads. */
export interface AuthHeaders {
  authorization: string;
  customerUuid: string;
  /** Pre-serialised `Cookie` header value (auth + Akamai cookies). */
  cookie?: string;
}

export interface GraphQLOp {
  operationName: string;
  query: string;
  variables: Record<string, unknown>;
  mfeName: string;
}

export interface TransportOptions {
  endpoint?: string;
  apiKey?: string;
  userAgent?: string;
  /** Minimum gap between requests in ms (polite usage). Default 1000. */
  throttleMs?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Returns current auth headers, or undefined for anonymous. */
  getAuth?: () => AuthHeaders | undefined;
  /** Called once on a 401; return true if a refresh succeeded (then we retry). */
  onUnauthorized?: () => Promise<boolean>;
}

function isUnauthorized(errors: readonly unknown[]): boolean {
  for (const e of errors) {
    const err = e as {
      extensions?: { http?: { status?: number } };
      message?: string;
      status?: unknown;
    };
    // Synthetic 401 envelope injected by post() for raw HTTP 401 responses.
    if (err.status === 401) return true;
    if (typeof err.message === "string" && /unauthor|401/i.test(err.message)) return true;
    // GraphQL extension checks (existing).
    if (err.extensions?.http?.status === 401) return true;
  }
  return false;
}

function uuid(): string {
  return randomUUID();
}

/**
 * Pure-HTTP transport for `xapi.tesco.com`. Builds the JSON-array request body,
 * assembles the header set Tesco expects, throttles to a polite rate, retries
 * once on a 401 (after refresh), and refuses to retry-storm a 429/403.
 */
export class GraphQLTransport {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly userAgent: string;
  private readonly throttleMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly getAuth: () => AuthHeaders | undefined;
  private readonly onUnauthorized?: () => Promise<boolean>;
  /** Serial gate: each request awaits the previous one's scheduled slot. */
  private gate: Promise<void> = Promise.resolve();
  private nextAllowedAt = 0;

  constructor(opts: TransportOptions = {}) {
    this.endpoint = opts.endpoint ?? ENDPOINT;
    this.apiKey = opts.apiKey ?? process.env.TESCO_API_KEY ?? PUBLIC_API_KEY;
    this.userAgent = opts.userAgent ?? DEFAULT_UA;
    this.throttleMs = opts.throttleMs ?? 1000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.getAuth = opts.getAuth ?? (() => undefined);
    this.onUnauthorized = opts.onUnauthorized;
  }

  /** Run one operation; returns its `data` object. Retries once on a 401. */
  async execute<T = Record<string, unknown>>(op: GraphQLOp): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.throttle();
      const result = await this.post(op);
      const errors = (result.errors ?? []) as unknown[];

      if (errors.length && isUnauthorized(errors)) {
        // First 401: refresh and retry once. Persistent 401: the session is dead.
        if (attempt === 0 && this.onUnauthorized && (await this.onUnauthorized())) continue;
        throw new AuthExpiredError(
          "Tesco auth expired and could not be refreshed — re-authenticate.",
        );
      }
      if (errors.length) throw new GraphQLRequestError(errors);
      return (result.data ?? {}) as T;
    }
    // Only reached if attempt 1 returned no errors above; keep TS happy.
    throw new AuthExpiredError("Tesco auth expired and could not be refreshed — re-authenticate.");
  }

  private async post(op: GraphQLOp): Promise<{ data?: unknown; errors?: unknown[] }> {
    const auth = this.getAuth();
    const headers: Record<string, string> = {
      "user-agent": this.userAgent,
      accept: "application/json",
      "content-type": "application/json",
      "accept-language": "en-GB",
      "x-apikey": this.apiKey,
      region: "UK",
      language: "en-GB",
      traceid: `${uuid()}:${uuid()}`,
      trkid: uuid(),
    };
    if (auth) {
      headers["authorization"] = auth.authorization;
      headers["customer-uuid"] = auth.customerUuid;
      if (auth.cookie) headers["cookie"] = auth.cookie;
    }

    const body = JSON.stringify([
      {
        operationName: op.operationName,
        variables: op.variables,
        extensions: { mfeName: op.mfeName },
        query: op.query,
      },
    ]);

    const res = await this.fetchImpl(this.endpoint, { method: "POST", headers, body });

    // Read the body once. Non-2xx responses are often plain text, not JSON.
    const text = await res.text();

    if (res.status === 401) {
      // Raw HTTP 401 (often non-JSON). Surface as unauthorized so execute() refreshes + retries.
      return { errors: [{ message: "HTTP 401 Unauthorized", status: 401 }] };
    }
    if (res.status === 403) {
      if (/invalid client/i.test(text)) {
        throw new ApiKeyError(
          'Tesco rejected the x-apikey (403 "Invalid Client"). The public key likely ' +
            "rotated — set the TESCO_API_KEY env var or update PUBLIC_API_KEY.",
        );
      }
      throw new RateLimitedError(403, "Tesco returned 403 (bot-blocked/forbidden) — backing off.");
    }
    if (res.status === 429) {
      throw new RateLimitedError(429, "Tesco returned 429 (rate limited) — backing off.");
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new GraphQLRequestError([
        { message: `HTTP ${res.status}: non-JSON body`, snippet: text.slice(0, 200) },
      ]);
    }
    const first = Array.isArray(json) ? json[0] : json;
    return (first ?? {}) as { data?: unknown; errors?: unknown[] };
  }

  /**
   * Hand out request slots serially. Each call chains onto the previous one's
   * scheduled slot, so N concurrent callers (e.g. `Promise.all`) are spaced
   * `throttleMs` apart rather than all firing at once.
   */
  private throttle(): Promise<void> {
    const slot = this.gate.then(async () => {
      const delay = this.nextAllowedAt - Date.now();
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      this.nextAllowedAt = Date.now() + this.throttleMs;
    });
    this.gate = slot.catch(() => {}); // one failure must not poison the chain
    return slot;
  }
}
