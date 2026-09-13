import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthorizationRequest } from "@valet/engine/authorization";
import { buildCurrentPolicySource } from "../bundles/current-policy-source.js";
import { SourceBundleHost } from "../bundles/host.js";
import { InMemorySourceBundleStorage } from "../bundles/in-memory-storage.js";
import { LocalValetEvaluator } from "../evaluators/local-valet.js";
import { WasmPolicyRuntime } from "../evaluators/wasm-runtime.js";
import { normalizePolicyDraft } from "./model.js";
import { projectActionDraftToCurrentSnapshot } from "./current-action-projection.js";
import type { PolicyDraftV1 } from "./types.js";

let runtime: WasmPolicyRuntime;
beforeAll(() => {
  runtime = new WasmPolicyRuntime();
});
afterAll(async () => runtime.close());
const draft: PolicyDraftV1 = {
  schemaVersion: 1,
  draftId: "draft-1",
  rules: [
    {
      ruleId: "rule-1",
      context: "tool.action",
      authority: "organization",
      owner: { kind: "org", id: "org-1" },
      subjects: ["org"],
      target: { "action.id": "gmail.send_email" },
      matcherGroups: [
        {
          id: "group-1",
          mode: "all",
          matchers: [
            {
              id: "matcher-1",
              field: "parameters.to",
              operator: "eq",
              value: "a@example.com",
            },
          ],
        },
      ],
      effect: "deny",
      appliesIn: "any",
      obligations: [],
      description: "",
      metadata: {},
    },
  ],
};
const request: AuthorizationRequest = {
  schemaVersion: 1,
  requestId: "request-1",
  idempotencyKey: "invocation-1",
  kind: "tool.action",
  subject: {
    orgId: "org-1",
    principal: { type: "user", id: "user-1" },
    invocation: { type: "interactive", id: "invocation-1" },
    sessionId: "session-1",
  },
  action: {
    service: "gmail",
    id: "gmail.send_email",
    riskLevel: "high",
    parameters: { to: "a@example.com" },
  },
  context: { evaluationTimeMs: 100 },
  facts: {},
};

describe("browser draft to current source contract", () => {
  it("maps losslessly, validates the bundle, and evaluates through LocalValetEvaluator", async () => {
    const normalized = normalizePolicyDraft(draft);
    const snapshot = projectActionDraftToCurrentSnapshot(normalized, "org-1");
    expect(snapshot.organizationPolicies[0]).toMatchObject({
      id: "rule-1",
      actionId: "gmail.send_email",
      paramMatchers: [{ path: "to", op: "eq", value: "a@example.com" }],
    });
    const built = buildCurrentPolicySource(snapshot);
    const provenance = JSON.parse(Buffer.from(built.bundle.files.find((file) => file.path.startsWith("provenance/"))!.contentBase64, "base64").toString("utf8"));
    expect(provenance.entries.find((entry: { rule_id: string }) => entry.rule_id === "rule-1")).toMatchObject({
      rule_id: "rule-1",
      start_line: expect.any(Number),
      end_line: expect.any(Number),
    });
    const host = new SourceBundleHost(new InMemorySourceBundleStorage(), runtime),
      identity = await host.publish(built.bundle);
    await host.activate("org-1", undefined, identity.sourceBundleDigest);
    const evaluator = await LocalValetEvaluator.create(host, runtime),
      result = await evaluator.evaluate(request);
    expect(result.decision).toMatchObject({
      effect: "deny",
      matchedRuleIds: ["rule-1"],
    });
    expect(result.policyDigest).toBe(identity.policyDigest);
  });
});
