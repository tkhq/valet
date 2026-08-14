/**
 * POST /api/sessions/:id/sandbox/replace — user-requested sandbox
 * replacement. Owner-gated like every other `/api/sessions/:id` route
 * (unknown/not-owned ids 404); 409s when there is ANY unsettled submission
 * (same busy rule as pause); happy path re-provisions a fresh sandbox at a
 * bumped epoch and leaves threads/history untouched.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { QueueItem } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions } from "../schema/index.js";

async function seedSession(api: TestApi, opts: { id: string; userId: string }): Promise<void> {
  const now = Date.now();
  await api.providers.db.insert(agentSessions).values({
    id: opts.id,
    userId: opts.userId,
    orgId: "local-org",
    workspace: `/tmp/replace-test-${opts.id}`,
    status: "active",
    ownerType: "user",
    ownerId: opts.userId,
    createdAt: now,
    updatedAt: now,
  });
}

async function warmSession(api: TestApi, opts: { id: string; userId: string }) {
  const session = await api.providers.engineHost.sessionFor(opts.id, {
    userId: opts.userId,
    orgId: "local-org",
    workspace: `/tmp/replace-test-${opts.id}`,
  });
  await session.attachment.ensureReady({ timeoutMs: 5_000 });
  return session;
}

async function admitQueued(api: TestApi, sessionId: string, threadId: string): Promise<void> {
  const now = Date.now();
  const { engineStore } = api.providers;
  await engineStore.saveThread(sessionId, {
    id: threadId,
    sessionId,
    key: `web:${threadId}`,
    status: "active",
    queueMode: "followup",
    createdAt: now,
    updatedAt: now,
  });
  const item: QueueItem = {
    id: "q-replace-1",
    threadId,
    content: "waiting in line",
    status: "queued",
    attemptCount: 0,
    maxAttempts: 10,
    timeoutAt: now + 3_600_000,
    createdAt: now,
    updatedAt: now,
  };
  await engineStore.admitSubmission(sessionId, threadId, item);
}

describe("POST /api/sessions/:id/sandbox/replace", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("re-provisions a fresh sandbox at a bumped epoch", async () => {
    api = await bootTestApi();
    const sessionId = "replace-happy";
    await seedSession(api, { id: sessionId, userId: "local-user" });
    const session = await warmSession(api, { id: sessionId, userId: "local-user" });
    const oldEpoch = session.attachment.currentEpoch();

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/sandbox/replace`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true };
    expect(body).toEqual({ ok: true });

    expect(session.attachment.state).toBe("ready");
    expect(session.attachment.currentEpoch()).toBeGreaterThan(oldEpoch);
  });

  it("409s while a submission is unsettled", async () => {
    api = await bootTestApi();
    const sessionId = "replace-busy";
    await seedSession(api, { id: sessionId, userId: "local-user" });
    const session = await warmSession(api, { id: sessionId, userId: "local-user" });
    const oldEpoch = session.attachment.currentEpoch();
    await admitQueued(api, sessionId, "th-replace-busy");

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/sandbox/replace`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
    expect(session.attachment.currentEpoch()).toBe(oldEpoch);
  });

  it("404s for an unknown session", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/sessions/nope/sandbox/replace`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});
