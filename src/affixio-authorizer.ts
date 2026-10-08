import type {
  AuthorizationDecision,
  AuthorizeAction,
  PreExecutionAuthorizer,
} from "./authorization.js";

export interface AffixioAuthorizerOptions {
  apiKey: string;
  credential: unknown | ((action: AuthorizeAction) => unknown | Promise<unknown>);
  apiBase?: string;
  timeoutMs?: number;
  importModule?: (name: string) => Promise<Record<string, unknown>>;
}

export function createAffixioAuthorizer(options: AffixioAuthorizerOptions): PreExecutionAuthorizer {
  return {
    async authorize(action: AuthorizeAction): Promise<AuthorizationDecision> {
      const importModule =
        options.importModule ??
        ((name: string) =>
          new Function("name", "return import(name)")(name) as Promise<Record<string, unknown>>);
      const affixio = await importModule("affixio");
      const createAgentTrust = affixio.createAgentTrust as
        | ((opts: Record<string, unknown>) => {
            authorise(input: Record<string, unknown>): Promise<Record<string, unknown>>;
            dispose?: () => void;
          })
        | undefined;
      const AffixSDK = affixio.AffixSDK as
        | (new (
            opts: Record<string, unknown>,
          ) => {
            verifyLocal(
              circuitId: string,
              proof: string,
              opts?: Record<string, unknown>,
            ): Promise<Record<string, unknown>>;
            dispose?: () => void;
          })
        | undefined;
      if (!createAgentTrust || !AffixSDK) {
        throw new Error("affixio must export createAgentTrust and AffixSDK");
      }

      const credential =
        typeof options.credential === "function"
          ? await options.credential(action)
          : options.credential;
      const trust = createAgentTrust({ apiKey: options.apiKey, apiBase: options.apiBase });
      const sdk = new AffixSDK({
        apiKey: options.apiKey,
        apiBase: options.apiBase,
        proofMode: "hmac",
        licenceOnly: true,
        autoFlush: false,
        queueUnsyncedProofs: false,
      });
      try {
        const receipt = await trust.authorise({
          credential,
          action: action.operation,
          resource: action.resource,
          args: action.args,
          attest: false,
        });
        if (!receipt.allowed) {
          return {
            allowed: false,
            proofVerified: false,
            reason: String(receipt.reason ?? "denied"),
            proofId: typeof receipt.proof_id === "string" ? receipt.proof_id : undefined,
          };
        }
        const verified = await sdk.verifyLocal(String(receipt.circuit_id), String(receipt.proof), {
          proofId: receipt.proof_id,
        });
        return {
          allowed: true,
          proofVerified: verified.valid === true && verified.verified === true,
          reason: typeof receipt.reason === "string" ? receipt.reason : undefined,
          proofId: typeof receipt.proof_id === "string" ? receipt.proof_id : undefined,
        };
      } finally {
        trust.dispose?.();
        sdk.dispose?.();
      }
    },
  };
}
