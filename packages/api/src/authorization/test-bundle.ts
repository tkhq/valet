import { createHash } from "node:crypto";
import type { AuthorizationRequest } from "@valet/engine/authorization";
import type { CanonicalSourceBundle } from "./bundles/types.js";

const POLICY = `package valet.authz
import rego.v1
decision := {
  "effect": "allow",
  "reasonCode": "local_valet_test",
  "matchedRuleIds": ["local.test"],
  "obligations": [],
  "redactions": [],
}
`;
const DATA = "{}";
const PROVENANCE = '{"entries":[]}';

export function testBundle(policy = POLICY, data = DATA): CanonicalSourceBundle {
  const files = [
    file("data/policy.json", "application/json", data),
    file("policies/main.rego", "application/vnd.valet.rego.v1", policy),
    file("provenance/map.json", "application/vnd.valet.policy-provenance.v1+json", PROVENANCE),
  ];
  const manifest = {
    capabilityProfileVersion: 1,
    contractVersion: 1,
    engineName: "valet-policy-engine",
    engineVersion: "0.1.0",
    entrypoint: "data.valet.authz.decision",
    files: files.map(({ path, mediaType, bytes }) => ({
      byteLength: Buffer.byteLength(bytes),
      mediaType,
      path,
      sha256: sha256(bytes),
    })),
    interpreter: {
      name: "regorus",
      revision: "aee1a9b12b1ec1e0599a53acd665b31d3bb5ea2e",
      version: "0.12.0",
    },
    mediaType: "application/vnd.valet.policy-source-bundle.v1+json",
    policyVersion: "test-v1",
    regoVersion: "v1",
    schemaVersion: 1,
    source: { license: "UNLICENSED", origin: "valet-test", revision: "test" },
  };
  return {
    manifestJson: JSON.stringify(manifest),
    files: files.map(({ path, bytes }) => ({ path, contentBase64: Buffer.from(bytes).toString("base64") })),
  };
}

export function testRequest(): AuthorizationRequest {
  return {
    schemaVersion: 1,
    requestId: "request-1",
    idempotencyKey: "interactive:invocation-1",
    kind: "tool.action",
    subject: {
      orgId: "org-1",
      principal: { type: "user", id: "user-1" },
      invocation: { type: "interactive", id: "invocation-1" },
    },
    action: { id: "test.action" },
    context: {},
    facts: {},
  };
}

function file(path: string, mediaType: string, bytes: string) {
  return { path, mediaType, bytes };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

