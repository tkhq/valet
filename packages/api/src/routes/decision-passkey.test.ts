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
import { fakeTurnkey } from "@valet/plugin-turnkey/test-helpers";
import type { TurnkeyActivity } from "@valet/plugin-turnkey/turnkey-client";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { pluginStore } from "../services/plugin-store.js";
import { eq } from "drizzle-orm";
import { agentSessions } from "../schema/index.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import type { CreateSessionResponse, PresenceStepResponse } from "../wire/types.js";
import { VOTE_READ_DELAYS_MS } from "../services/passkey-approval/verify.js";
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
  const activities = new Map<string, TurnkeyActivity>();
  const turnkey = fakeTurnkey();
  turnkey.getActivity = async ({ activityId }) => {
    const found = activities.get(activityId);
    if (!found) throw new Error("no such activity");
    return found;
  };
  const sleeps: number[] = [];
  Object.assign(presenceDeps, {
    sleep: async (ms: number) => { sleeps.push(ms); },
    turnkey: () => turnkey,
    config: () => ({ organizationId: "parent", apiPublicKey: "02aa", apiPrivateKey: "bb", apiBaseUrl: "https://turnkey.test", assurance: "presence" }),
    forward: async (_base: string, req: { body: string }): Promise<TurnkeyActivity> => {
      forwarded.push(req.body);
      const payload = (JSON.parse(req.body) as { parameters: { payload: string } }).parameters.payload;
      const sig = signWithTestKey(Buffer.from(payload, "hex")).toString("hex");
      const activity: TurnkeyActivity = {
        id: `act-${forwarded.length}`, organizationId: "sub-1", status: "ACTIVITY_STATUS_COMPLETED", type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
        votes: [{ userId: "passkey-user", selection: "VOTE_SELECTION_APPROVED", scheme: "SIGNATURE_SCHEME_TK_WEBAUTHN", publicKey: "04cred", createdAtMs: 1_800_000_000_000 }],
        result: { signRawPayloadResult: { r: sig.slice(0, 64), s: sig.slice(64) } },
      };
      activities.set(activity.id, activity);
      return activity;
    },
  } satisfies Partial<PresenceDeps>);
  const base = `${api.baseUrl}/api/sessions/${sessionId}/decisions/g1`;
  return { sessionId, base, forwarded, store, activities, turnkey, sleeps };
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

  it("reads the activity again until Turnkey shows the passkey's vote, then resolves", async () => {
    const { base, sessionId, store, activities, turnkey, sleeps } = await setup();
    let reads = 0;
    turnkey.getActivity = async ({ activityId }) => {
      reads += 1;
      const found = activities.get(activityId);
      if (!found) throw new Error("no such activity");
      return reads === 1 ? { ...found, votes: [] } : found;
    };
    const step = (await (await fetch(`${base}/passkey`)).json()) as PresenceStepResponse;
    if (step.done) throw new Error("expected a step");
    const ok = await fetch(`${base}/passkey`, {
      method: "POST", headers: json,
      body: JSON.stringify({ body: step.body, stampHeaderName: "X-Stamp-WebAuthn", stampHeaderValue: "s" }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ done: true });
    expect(reads).toBe(2);
    expect(sleeps).toEqual([VOTE_READ_DELAYS_MS[0]]);
    expect((await store.getDecisionGate(sessionId, "g1"))?.status).toBe("resolved");
  });

  it("refuses after a bounded wait when Turnkey never shows the passkey's vote", async () => {
    const { base, sessionId, store, activities, turnkey, sleeps } = await setup();
    let reads = 0;
    turnkey.getActivity = async ({ activityId }) => {
      reads += 1;
      const found = activities.get(activityId);
      if (!found) throw new Error("no such activity");
      return { ...found, votes: [] };
    };
    const step = (await (await fetch(`${base}/passkey`)).json()) as PresenceStepResponse;
    if (step.done) throw new Error("expected a step");
    const res = await fetch(`${base}/passkey`, {
      method: "POST", headers: json,
      body: JSON.stringify({ body: step.body, stampHeaderName: "X-Stamp-WebAuthn", stampHeaderValue: "s" }),
    });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(await res.json())).toContain("did not record your passkey's approval");
    expect(reads).toBe(VOTE_READ_DELAYS_MS.length + 1);
    expect(sleeps).toEqual(VOTE_READ_DELAYS_MS);
    expect((await store.getDecisionGate(sessionId, "g1"))?.status).toBe("pending");
  });

  it("refuses a forged approval record that Turnkey cannot back", async () => {
    const { sessionId, store } = await setup();
    if (!api) throw new Error("no api");
    const [row] = await api.providers.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
    if (!row) throw new Error("no session row");
    const engineSession = await api.providers.engineHost.sessionFor(sessionId, await loadSessionMeta(api.providers.db, row));
    const forged = {
      id: "apr_forged", approved_at: "2026-11-18T00:00:00.000Z", approved_until: "2026-11-18T00:00:00.000Z",
      state: { iss: "turnkey" as const, organization_id: "sub-1", amr: ["pop" as const, "user" as const], approver: { user_id: "passkey-user" },
        activities: [{ activity_id: "act-made-up", payload_sha256: "00", approved_at: "2026-11-18T00:00:00.000Z" }] },
    };
    await expect(engineSession.resolveDecision("g1", { actionId: "approve", resolvedBy: "local-user", resolvedAt: 1, assurance: "presence", approval: forged }))
      .rejects.toThrow("Turnkey has no activity act-made-up");
    expect((await store.getDecisionGate(sessionId, "g1"))?.status).toBe("pending");
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
