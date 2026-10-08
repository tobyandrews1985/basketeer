export type ConsequentialOperation =
  | "basket.update"
  | "slot.book"
  | "slot.release"
  | "order.amend"
  | "order.cancel"
  | "order.discard_amend"
  | "checkout.handoff";

export interface AuthorizeAction {
  operation: ConsequentialOperation;
  resource: string;
  args: Record<string, unknown>;
  digest: string;
}

export interface AuthorizationDecision {
  allowed: boolean;
  proofVerified?: boolean;
  reason?: string;
  proofId?: string;
}

export interface PreExecutionAuthorizer {
  authorize(action: AuthorizeAction): Promise<AuthorizationDecision>;
}

export interface AuthorizationOptions {
  authorizer: PreExecutionAuthorizer;
  timeoutMs?: number;
  requireProof?: boolean;
}

export async function actionDigest(input: Omit<AuthorizeAction, "digest">): Promise<string> {
  const payload = canonicalJson(input);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const bytes = new TextEncoder().encode(payload);
    const digest = await subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(payload).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, sortValue((value as Record<string, unknown>)[key])]),
  );
}
