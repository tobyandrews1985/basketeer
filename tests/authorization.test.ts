import { describe, expect, it } from "vitest";
import { createAffixioAuthorizer } from "../src/affixio-authorizer.js";
import type { AuthorizeAction, PreExecutionAuthorizer } from "../src/authorization.js";
import { Basketeer } from "../src/client.js";
import { AuthorizationDeniedError } from "../src/errors.js";
import { SESSION, stubFetch } from "./helpers.js";

const UPDATE_BASKET_BODY = [
  {
    data: {
      basket: {
        id: "b1",
        guidePrice: 42.35,
        items: [{ id: "L1", quantity: 1, unit: "pcs", product: { id: "111", isForSale: true } }],
        updates: { items: [{ id: "111", successful: true }] },
      },
    },
  },
];

const GET_BASKET_BODY = [
  {
    data: {
      basket: {
        id: "b1",
        guidePrice: 42.35,
        items: [{ id: "L1", quantity: 1, unit: "pcs", product: { id: "111", isForSale: true } }],
      },
    },
  },
];

function allow(actions: AuthorizeAction[] = []): PreExecutionAuthorizer {
  return {
    authorize: async (action) => {
      actions.push(action);
      return { allowed: true, proofVerified: true, proofId: "proof-1" };
    },
  };
}

describe("optional pre-execution authorization", () => {
  it("preserves existing behaviour when no authorizer is configured", async () => {
    const { impl, calls } = stubFetch([{ body: UPDATE_BASKET_BODY }]);
    const t = new Basketeer({ session: SESSION, throttleMs: 0, fetchImpl: impl });

    await t.basket.set("111", 1);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.body[0].operationName).toBe("UpdateBasket");
  });

  it("authorizes basket mutations before sending UpdateBasket", async () => {
    const actions: AuthorizeAction[] = [];
    const { impl, calls } = stubFetch([{ body: UPDATE_BASKET_BODY }]);
    const t = new Basketeer({
      session: SESSION,
      throttleMs: 0,
      fetchImpl: impl,
      authorization: { authorizer: allow(actions) },
    });

    await t.basket.set("111", 2);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      operation: "basket.update",
      resource: "tesco:basket:current",
    });
    expect(actions[0]!.args.items).toEqual([
      {
        adjustment: false,
        id: "111",
        newValue: 2,
        newUnitChoice: "pcs",
        substitutionOption: "FindSuitableAlternative",
      },
    ]);
    expect(actions[0]!.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(calls).toHaveLength(1);
  });

  it("blocks DENY before a basket mutation reaches Tesco", async () => {
    const { impl, calls } = stubFetch([{ body: UPDATE_BASKET_BODY }]);
    const t = new Basketeer({
      session: SESSION,
      throttleMs: 0,
      fetchImpl: impl,
      authorization: {
        authorizer: {
          authorize: async () => ({ allowed: false, proofVerified: false, reason: "policy_no" }),
        },
      },
    });

    await expect(t.basket.set("111", 1)).rejects.toMatchObject({
      name: "AuthorizationDeniedError",
      operation: "basket.update",
      reason: "policy_no",
    });
    expect(calls).toHaveLength(0);
  });

  it("blocks ALLOW without a verified proof by default", async () => {
    const { impl, calls } = stubFetch([{ body: UPDATE_BASKET_BODY }]);
    const t = new Basketeer({
      session: SESSION,
      throttleMs: 0,
      fetchImpl: impl,
      authorization: {
        authorizer: { authorize: async () => ({ allowed: true, reason: "missing_proof" }) },
      },
    });

    await expect(t.basket.remove("111")).rejects.toBeInstanceOf(AuthorizationDeniedError);
    expect(calls).toHaveLength(0);
  });

  it("can allow a decision without proof when a caller explicitly disables proof enforcement", async () => {
    const { impl, calls } = stubFetch([{ body: UPDATE_BASKET_BODY }]);
    const t = new Basketeer({
      session: SESSION,
      throttleMs: 0,
      fetchImpl: impl,
      authorization: {
        requireProof: false,
        authorizer: { authorize: async () => ({ allowed: true }) },
      },
    });

    await t.basket.remove("111");

    expect(calls).toHaveLength(1);
  });

  it("fails closed when authorization throws or times out", async () => {
    const { impl, calls } = stubFetch([{ body: UPDATE_BASKET_BODY }]);
    const broken = new Basketeer({
      session: SESSION,
      throttleMs: 0,
      fetchImpl: impl,
      authorization: {
        authorizer: {
          authorize: async () => {
            throw new Error("verifier_down");
          },
        },
      },
    });
    await expect(broken.basket.set("111", 1)).rejects.toMatchObject({
      name: "AuthorizationDeniedError",
      reason: "verifier_down",
    });

    const slow = new Basketeer({
      session: SESSION,
      throttleMs: 0,
      fetchImpl: impl,
      authorization: {
        timeoutMs: 1,
        authorizer: { authorize: () => new Promise(() => undefined) },
      },
    });
    await expect(slow.basket.set("111", 1)).rejects.toMatchObject({
      name: "AuthorizationDeniedError",
      reason: "authorization_timeout",
    });
    expect(calls).toHaveLength(0);
  });

  it("authorizes checkout handoff against the actual basket snapshot", async () => {
    const actions: AuthorizeAction[] = [];
    const { impl, calls } = stubFetch([{ body: GET_BASKET_BODY }]);
    const t = new Basketeer({
      session: SESSION,
      throttleMs: 0,
      fetchImpl: impl,
      authorization: { authorizer: allow(actions) },
    });

    const result = await t.checkout();

    expect(result.url).toContain("/checkout/");
    expect(calls).toHaveLength(1);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      operation: "checkout.handoff",
      resource: "tesco:checkout:b1",
    });
    expect(actions[0]!.args).toMatchObject({
      basketId: "b1",
      guidePrice: 42.35,
      itemCount: 1,
    });
  });

  it("changing consequential parameters changes the authorization digest", async () => {
    const actions: AuthorizeAction[] = [];
    const { impl } = stubFetch([{ body: UPDATE_BASKET_BODY }, { body: UPDATE_BASKET_BODY }]);
    const t = new Basketeer({
      session: SESSION,
      throttleMs: 0,
      fetchImpl: impl,
      authorization: { authorizer: allow(actions) },
    });

    await t.basket.set("111", 1);
    await t.basket.set("111", 2);

    expect(actions).toHaveLength(2);
    expect(actions[0]!.digest).not.toBe(actions[1]!.digest);
  });
});

describe("createAffixioAuthorizer", () => {
  const action: AuthorizeAction = {
    operation: "basket.update",
    resource: "tesco:basket:current",
    args: { items: [{ id: "111", newValue: 1 }] },
    digest: "digest-1",
  };

  it("authorizes through AffixIO and verifies the returned proof locally", async () => {
    const calls: string[] = [];
    const authorizer = createAffixioAuthorizer({
      apiKey: "test-key",
      credential: { agent_id: "agent-1" },
      importModule: async () => ({
        createAgentTrust: () => ({
          authorise: async (input: Record<string, unknown>) => {
            calls.push(String(input.resource));
            return {
              allowed: true,
              reason: "granted",
              proof_id: "proof-1",
              circuit_id: "simple_yesno",
              proof: "proof-bytes",
            };
          },
          dispose: () => calls.push("trust-disposed"),
        }),
        AffixSDK: class {
          async verifyLocal(circuitId: string, proof: string) {
            calls.push(`${circuitId}:${proof}`);
            return { valid: true, verified: true };
          }
          dispose() {
            calls.push("sdk-disposed");
          }
        },
      }),
    });

    const decision = await authorizer.authorize(action);

    expect(decision).toEqual({
      allowed: true,
      proofVerified: true,
      proofId: "proof-1",
      reason: "granted",
    });
    expect(calls).toEqual([
      "tesco:basket:current",
      "simple_yesno:proof-bytes",
      "trust-disposed",
      "sdk-disposed",
    ]);
  });

  it("does not mark an AffixIO allow as verified when local proof verification fails", async () => {
    const authorizer = createAffixioAuthorizer({
      apiKey: "test-key",
      credential: { agent_id: "agent-1" },
      importModule: async () => ({
        createAgentTrust: () => ({
          authorise: async () => ({
            allowed: true,
            reason: "granted",
            proof_id: "proof-1",
            circuit_id: "simple_yesno",
            proof: "proof-bytes",
          }),
        }),
        AffixSDK: class {
          async verifyLocal() {
            return { valid: false, verified: false };
          }
        },
      }),
    });

    await expect(
      new Basketeer({
        authorization: { authorizer },
      }).basket.set("111", 1),
    ).rejects.toMatchObject({
      name: "AuthorizationDeniedError",
      reason: "proof_not_verified",
    });
  });
});
