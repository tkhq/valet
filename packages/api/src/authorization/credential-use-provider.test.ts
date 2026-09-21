import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialProvider } from "@valet/engine";
import type { PolicyDecisionEnvelope } from "@valet/engine/authorization";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { CredentialUseDeniedError, withCredentialUseAuthorization } from "./credential-use-provider.js";

let pg: TestPgDb | undefined;
afterEach(async () => { await pg?.cleanup(); pg = undefined; });

function envelope(requestId: string, effect: "allow" | "deny" | "require_approval"): PolicyDecisionEnvelope {
  return {
    schemaVersion: 1,
    requestId,
    requestSubjectDigest: "a".repeat(64),
    inputDigest: "b".repeat(64),
    policyDigest: "c".repeat(64),
    sourceBundleDigest: "d".repeat(64),
    evaluator: { kind: "local_valet", engineDigest: "e".repeat(64) },
    decision: {
      effect,
      reasonCode: "test",
      matchedRuleIds: ["test.rule"],
      obligations: [],
      redactions: [],
      ...(effect === "require_approval" ? { approvalRequirement: { tier: "owner", approverType: "user" as const, replay: "once" as const } } : {}),
    },
    evaluatedAtMs: 1,
  };
}

function binding() {
  return {
    organizationId: "org-1",
    actorUserId: "user-1",
    principal: { type: "user" as const, id: "user-1" },
    owner: { type: "user" as const, id: "user-1" },
    service: "gmail",
    credentialClass: "oauth2",
    actionId: "gmail.send_email",
    operation: "workflow" as const,
    workflowExecutionId: "run-1",
    invocationId: "invocation-1",
  };
}

describe("credential use provider authorization", () => {
  it.each(["deny", "require_approval"] as const)("keeps the provider at spy zero for %s", async (effect) => {
    pg = await freshTestPgDb();
    const get = vi.fn(async () => ({ accessToken: "SECRET-CANARY" }));
    const inner: CredentialProvider = { get, request: async () => ({ accessToken: "SECRET-CANARY" }) };
    const authorize = vi.fn(async (request) => envelope(request.requestId, effect));
    const provider = withCredentialUseAuthorization(inner, { db: pg.appDb, authorization: { authorize }, binding: binding(), now: () => 1 });

    await expect(provider.get()).rejects.toBeInstanceOf(CredentialUseDeniedError);
    expect(get).not.toHaveBeenCalled();
    expect(JSON.stringify(authorize.mock.calls)).not.toContain("SECRET-CANARY");
  });
});
