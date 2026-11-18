/**
 * `GET|POST /api/sessions/:id/decisions/:gateId/passkey` and the resolve
 * route's refusal of a plain Approve on a passkey gate. Turnkey is faked at
 * the forward seam: it signs with a test key, as the person's passkey-stamped
 * activity would.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { PRESENCE_REQUIRED_MESSAGE } from "@valet/engine";
import { COLLECTIONS, DEFAULT_KEY, PLUGIN_NAME, type EnrollmentDoc } from "@valet/plugin-turnkey/store";
import { PUBLIC_HEX, signWithTestKey } from "@valet/plugin-turnkey/test-helpers/commit-fixtures";
import type { TurnkeyActivity } from "@valet/plugin-turnkey/turnkey-client";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { pluginStore } from "../services/plugin-store.js";
import type { CreateSessionResponse, PresenceStepResponse } from "../wire/types.js";
import { presenceDeps, type PresenceDeps } from "./decision-passkey.js";

let api: TestApi | undefined;
const original: PresenceDeps = { ...presenceDeps };

afterEach(async () => {
  Object.assign(presenceDeps, original);
  await api?.cleanup();
  api = undefined;
});

const ENROLLMENT: EnrollmentDoc = {
  subOrgId: "sub-1",
  passkeyUserId: "passkey-user",
  mode: "presence",
  signingKey: { privateKeyId: "pk-1", publicKeyHex: PUBLIC_HEX, publicKey: "ssh-ed25519 AAAA", fingerprint: "SHA256:x", activityId: "a0" },
  signingTagId: "ktag",
  createdAt: 1,
};

async function setup() {
  api = await bootTestApi();
  const res = await fetch(`${api.baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace: "/tmp" }),
  });
  const { id: sessionId } = (await res.json()) as CreateSessionResponse;
  await fetch(`${api.baseUrl}/api/sessions/${sessionId}/decisions`);
  const store = api.providers.engineStore;
  const thread = { id: "passkey-thread", sessionId, key: "web:passkey", status: "active" as const, queueMode: "followup" as const, createdAt: 1, updatedAt: 1 };
  await store.saveThread(sessionId, thread);
  await store.saveDecisionGate(sessionId, thread.id, {
    id: "g1", sessionId, threadId: thread.id, type: "approval", queueItemId: "q", resumeKey: "deploy", ordinal: 0,
    title: "Deploy?", body: "to prod", context: { assurance: "presence" },
    actions: [{ id: "approve", label: "Approve with passkey", approves: true }, { id: "reject", label: "Reject" }],
    status: "pending", createdAt: 1, updatedAt: 1,
  });
  await pluginStore(api.providers.db, PLUGIN_NAME).user("local-user").put(COLLECTIONS.enrollment, DEFAULT_KEY, ENROLLMENT);
  const forwarded: string[] = [];
  Object.assign(presenceDeps, {
    config: () => ({ organizationId: "parent", apiPublicKey: "02aa", apiPrivateKey: "bb", apiBaseUrl: "https://turnkey.test", assurance: "presence" }),
    forward: async (_base: string, req: { body: string }): Promise<TurnkeyActivity> => {
      forwarded.push(req.body);
      const payload = (JSON.parse(req.body) as { parameters: { payload: string } }).parameters.payload;
      const sig = signWithTestKey(Buffer.from(payload, "hex")).toString("hex");
      return {
        id: `act-${forwarded.length}`, organizationId: "sub-1", status: "ACTIVITY_STATUS_COMPLETED", type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
        votes: [{ userId: "passkey-user", selection: "VOTE_SELECTION_APPROVED", scheme: "SIGNATURE_SCHEME_TK_WEBAUTHN", publicKey: "04cred", createdAtMs: 1_800_000_000_000 }],
        result: { signRawPayloadResult: { r: sig.slice(0, 64), s: sig.slice(64) } },
      };
    },
  } satisfies Partial<PresenceDeps>);
  const base = `${api.baseUrl}/api/sessions/${sessionId}/decisions/g1`;
  return { sessionId, base, forwarded, store };
}

const json = { "Content-Type": "application/json" };

describe("passkey approval", () => {
  it("refuses a plain Approve on a passkey gate and keeps it pending", async () => {
    const { base, sessionId, store } = await setup();
    const res = await fetch(`${base}/resolve`, { method: "POST", headers: json, body: JSON.stringify({ actionId: "approve" }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: PRESENCE_REQUIRED_MESSAGE });
    expect((await store.getDecisionGate(sessionId, "g1"))?.status).toBe("pending");
  });

  it("refuses a tampered body before Turnkey, then resolves with presence evidence on the issued one", async () => {
    const { base, sessionId, store, forwarded } = await setup();
    const step = (await (await fetch(`${base}/passkey`)).json()) as PresenceStepResponse;
    if (step.done) throw new Error("expected a step");
    expect(step).toMatchObject({ index: 0, total: 1, label: "Deploy?" });

    const tampered = step.body.replace(/"payload":"[0-9a-f]+"/, `"payload":"${"00".repeat(32)}"`);
    const bad = await fetch(`${base}/passkey`, {
      method: "POST", headers: json,
      body: JSON.stringify({ body: tampered, stampHeaderName: "X-Stamp-WebAuthn", stampHeaderValue: "s" }),
    });
    expect(bad.status).toBe(400);
    expect(forwarded).toHaveLength(0);

    const apiKeyStamp = await fetch(`${base}/passkey`, {
      method: "POST", headers: json,
      body: JSON.stringify({ body: step.body, stampHeaderName: "X-Stamp", stampHeaderValue: "s" }),
    });
    expect(apiKeyStamp.status).toBe(400);

    const ok = await fetch(`${base}/passkey`, {
      method: "POST", headers: json,
      body: JSON.stringify({ body: step.body, stampHeaderName: "X-Stamp-WebAuthn", stampHeaderValue: "s" }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ done: true });
    expect(forwarded).toEqual([step.body]);
    const gate = await store.getDecisionGate(sessionId, "g1");
    const payload = (JSON.parse(step.body) as { parameters: { payload: string } }).parameters.payload;
    expect(gate).toMatchObject({
      status: "resolved",
      resolution: {
        actionId: "approve",
        assurance: "presence",
        approval: {
          state: {
            iss: "turnkey",
            organization_id: "sub-1",
            amr: ["pop", "user"],
            approver: { user_id: "passkey-user", authenticator: { scheme: "SIGNATURE_SCHEME_TK_WEBAUTHN", public_key: "04cred" } },
            activities: [{ activity_id: "act-1", payload_sha256: createHash("sha256").update(Buffer.from(payload, "hex")).digest("hex"), approved_at: "2027-01-15T08:00:00.000Z" }],
          },
        },
      },
    });
    const approval = gate?.resolution?.approval;
    expect(approval?.id).toMatch(/^apr_/);
    expect(approval?.approved_until).toBe(approval?.approved_at);
  });

  it("names the setup fix when the approver has no signing setup", async () => {
    const { base } = await setup();
    if (!api) throw new Error("no api");
    await pluginStore(api.providers.db, PLUGIN_NAME).user("local-user").delete(COLLECTIONS.enrollment, DEFAULT_KEY);
    const res = await fetch(`${base}/passkey`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("Settings, Commit signing");
  });
});
