/**
 * POST /api/sessions/:id/pause (sandbox hibernation plan, Task 4) — manual
 * hibernation. Owner-gated like every other `/api/sessions/:id` route
 * (unknown/not-owned ids 404); 409s when a turn is running/gated or the
 * provider lacks hibernation capability; happy path suspends the sandbox
 * and stamps the row `"hibernated"`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import type {
  QueueItem,
  Sandbox,
  SandboxCapabilities,
  SandboxCreateOpts,
  SandboxProvider,
  SandboxStatus,
} from "@valet/engine";
import { VirtualSandbox } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions } from "../schema/index.js";
import type { PauseSessionResponse } from "../wire/types.js";

/** Scripted hibernation-capable provider — mirrors
 * `host.idle-sweep.test.ts`'s `HibernatingTestProvider`. */
class HibernatingTestProvider implements SandboxProvider {
  readonly backend = "hib-pause-test";
  readonly suspendCalls: string[] = [];
  readonly resumeCalls: string[] = [];
  private sandboxes = new Map<string, VirtualSandbox>();
  private nextId = 1;

  capabilities(): SandboxCapabilities {
    return {
      snapshot: "none",
      persistentWorkspace: false,
      tunnels: false,
      warmPool: false,
      hibernation: true,
      coldStartEstimateMs: 0,
    };
  }

  async create(_opts: SandboxCreateOpts): Promise<Sandbox> {
    const id = `hibp-${this.nextId++}`;
    const sb = new VirtualSandbox(id);
    this.sandboxes.set(id, sb);
    return sb;
  }

  async restore(id: string): Promise<Sandbox> {
    const sb = this.sandboxes.get(id);
    if (!sb) throw new Error(`sandbox not found: ${id}`);
    return sb;
  }

  async destroy(id: string): Promise<void> {
    this.sandboxes.delete(id);
  }

  async status(id: string): Promise<SandboxStatus> {
    return this.sandboxes.has(id) ? { id, state: "ready" } : { id, state: "released" };
  }

  async suspend(id: string): Promise<void> {
    this.suspendCalls.push(id);
  }

  async resume(id: string): Promise<void> {
    this.resumeCalls.push(id);
  }
}

async function seedSession(api: TestApi, opts: { id: string; userId: string }): Promise<void> {
  const now = Date.now();
  await api.providers.db.insert(agentSessions).values({
    id: opts.id,
    userId: opts.userId,
    orgId: "local-org",
    workspace: `/tmp/pause-test-${opts.id}`,
    status: "active",
    ownerType: "user",
    ownerId: opts.userId,
    createdAt: now,
    updatedAt: now,
  });
}

/** Builds/restores the engine session and drives its attachment to `ready`
 * — mirrors `gateway-proxy.test.ts`'s `warmSandbox` helper. */
async function warmSession(api: TestApi, opts: { id: string; userId: string }) {
  const session = await api.providers.engineHost.sessionFor(opts.id, {
    userId: opts.userId,
    orgId: "local-org",
    workspace: `/tmp/pause-test-${opts.id}`,
  });
  await session.attachment.ensureReady({ timeoutMs: 5_000 });
  return session;
}

let nextItemId = 1;

/** Admits a queue item and claims it (queued -> running), leaving it
 * unsettled with status `"running"`. */
async function admitRunning(api: TestApi, sessionId: string, threadId: string): Promise<void> {
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
    id: `q-${nextItemId++}`,
    threadId,
    content: "still going",
    status: "queued",
    attemptCount: 0,
    maxAttempts: 10,
    timeoutAt: now + 3_600_000,
    createdAt: now,
    updatedAt: now,
  };
  const { item: admitted } = await engineStore.admitSubmission(sessionId, threadId, item);
  const claimed = await engineStore.claimSubmission({
    sessionId,
    threadId,
    itemId: admitted.id,
    attemptId: "attempt-1",
    ownerId: "owner-1",
  });
  expect(claimed?.status).toBe("running");
}

describe("POST /api/sessions/:id/pause", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("suspends the sandbox and marks the session hibernated", async () => {
    const provider = new HibernatingTestProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const sessionId = "pause-happy";
    await seedSession(api, { id: sessionId, userId: "local-user" });
    const session = await warmSession(api, { id: sessionId, userId: "local-user" });
    const sandboxId = session.attachment.current()?.id;
    expect(sandboxId).toBeDefined();

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/pause`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PauseSessionResponse;
    expect(body).toEqual({ status: "hibernated" });

    expect(provider.suspendCalls).toEqual([sandboxId]);
    expect(session.attachment.state).toBe("suspended");

    const rows = await api.providers.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1);
    expect(rows[0]?.status).toBe("hibernated");
  });

  it("409s with 'a turn is running' when a submission is running", async () => {
    const provider = new HibernatingTestProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const sessionId = "pause-running";
    await seedSession(api, { id: sessionId, userId: "local-user" });
    await warmSession(api, { id: sessionId, userId: "local-user" });
    await admitRunning(api, sessionId, "th-pause-running");

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/pause`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: "a turn is running" });

    expect(provider.suspendCalls).toEqual([]);
  });

  it("404s for a session owned by a different user", async () => {
    const provider = new HibernatingTestProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const sessionId = "pause-nonowner";
    await seedSession(api, { id: sessionId, userId: "test-member" });

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/pause`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("404s for an unknown session id", async () => {
    const provider = new HibernatingTestProvider();
    api = await bootTestApi({ sandboxProvider: provider });

    const res = await fetch(`${api.baseUrl}/api/sessions/does-not-exist/pause`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("409s with 'provider does not support hibernation' when the capability is off", async () => {
    // Default bootTestApi provider is VirtualSandboxProvider, whose
    // capabilities().hibernation is false.
    api = await bootTestApi();
    const sessionId = "pause-nocap";
    await seedSession(api, { id: sessionId, userId: "local-user" });
    await warmSession(api, { id: sessionId, userId: "local-user" });

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/pause`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: "provider does not support hibernation" });
  });

  it("404s for an archived session and leaves the row untouched", async () => {
    const provider = new HibernatingTestProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const sessionId = "pause-archived";
    await seedSession(api, { id: sessionId, userId: "local-user" });
    await api.providers.db
      .update(agentSessions)
      .set({ status: "archived" })
      .where(eq(agentSessions.id, sessionId));

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/pause`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(provider.suspendCalls).toEqual([]);

    const rows = await api.providers.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1);
    expect(rows[0]?.status).toBe("archived");
  });

  it("404s for a deleted session", async () => {
    const provider = new HibernatingTestProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const sessionId = "pause-deleted";
    await seedSession(api, { id: sessionId, userId: "local-user" });
    await api.providers.db
      .update(agentSessions)
      .set({ status: "deleted" })
      .where(eq(agentSessions.id, sessionId));

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/pause`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(provider.suspendCalls).toEqual([]);

    const rows = await api.providers.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1);
    expect(rows[0]?.status).toBe("deleted");
  });

  it("409s 'sandbox is not ready to pause' when the attachment never reached ready, and writes nothing", async () => {
    const provider = new HibernatingTestProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const sessionId = "pause-not-ready";
    await seedSession(api, { id: sessionId, userId: "local-user" });
    // Deliberately do NOT warm the session — the attachment stays "detached"
    // and suspend() no-ops.

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/pause`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: "sandbox is not ready to pause" });
    expect(provider.suspendCalls).toEqual([]);

    const rows = await api.providers.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1);
    expect(rows[0]?.status).toBe("active");
  });
});
