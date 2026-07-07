/** Base class for every error this library throws. */
export class BasketeerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The session could not be renewed (refresh failed or no session present).
 * Callers must re-authenticate — interactively for OSS users, or via the
 * consumer's own re-login flow.
 */
export class AuthExpiredError extends BasketeerError {}

/**
 * Tesco returned 429/403 (rate limited or bot-blocked). The client never
 * retry-storms: it surfaces this so callers back off. Honour polite usage.
 */
export class RateLimitedError extends BasketeerError {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * The gateway rejected the `x-apikey` (HTTP 403, body `Forbidden: Invalid
 * Client`). The public key rotates ~monthly — set `TESCO_API_KEY` or update
 * `PUBLIC_API_KEY`. This is a configuration error, never retryable.
 */
export class ApiKeyError extends BasketeerError {}

/** Thrown when a requested resource does not exist (e.g. an unknown SKU). */
export class NotFoundError extends BasketeerError {}

/** The GraphQL response carried an `errors` array (non-auth). */
export class GraphQLRequestError extends BasketeerError {
  /** The raw GraphQL errors, for programmatic inspection. */
  readonly errors: unknown[];
  constructor(errors: unknown[]) {
    // Keep the message short and scrubbed — the raw array may echo request
    // context. Full detail stays on `.errors` for programmatic access; callers
    // should avoid logging the whole object.
    const first = (errors[0] as { message?: unknown })?.message;
    const summary = typeof first === "string" ? first : "request failed";
    const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : "";
    super(`Tesco GraphQL error: ${scrubSecrets(summary)}${more}`);
    this.errors = errors;
  }
}

/** Redact anything that looks like a bearer/JWT/cookie from a message. */
function scrubSecrets(s: string): string {
  return s
    .replace(/eyJ[A-Za-z0-9_-]{10,}/g, "«jwt»")
    .replace(/(OAuth\.[A-Za-z]+|_abck|bm_[a-z]+)=[^;\s]+/gi, "$1=«redacted»");
}

/** A basket line update was rejected by Tesco (updates.items[].successful === false). */
export class LineRejectedError extends BasketeerError {
  readonly lineId: string;
  constructor(lineId: string) {
    super(`Tesco rejected basket line ${lineId}`);
    this.lineId = lineId;
  }
}

/**
 * The SKU passed to `basket.add`/`set` is unavailable for the basket's
 * slot/store (Tesco's `isForSale` is false). Tesco silently accepts these on
 * write then drops them at checkout, so the client rolls the line back and
 * throws this instead. The batch `basket.update` does not throw this — it
 * reports unavailable SKUs on its result. Availability is slot-specific —
 * see {@link Product.available}.
 */
export class ItemUnavailableError extends BasketeerError {
  readonly skus: string[];
  constructor(skus: string[]) {
    super(`Unavailable for your slot, not added: ${skus.join(", ")}`);
    this.skus = skus;
  }
}
