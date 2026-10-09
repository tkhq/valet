/**
 * Background work routes and the routes that must honor it (fix wave 2,
 * group C): the human list and cancel (H8), pause and replace under a lease
 * (B8), thread archive (H7), and owner move (H11).
 *
 * Wakeup and lease rows are seeded straight into the engine store. A fake
 * model answers each signal turn, so no network call happens.
 */
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  VirtualSandbox,
  type Lease,
  type Sandbox,
  type SandboxCapabilities,
  type SandboxProvider,
  type SandboxStatus,
  type Wakeup,
} from "@valet/engine";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, teamMembers, teams } from "../schema/index.js";
import type {
  CancelSessionWakeupResponse,
  ListSessionWakeupsResponse,
  PatchSessionResponse,
  PauseSessionResponse,
} from "../wire/types.js";

const HOUR_MS = 3_600_000;

/** A hibernation-capable provider whose sandboxes record job cancels. */
class LeaseTestProvider implements SandboxProvider {
  readonly backend = "lease-route-test";
  readonly suspendCalls: string[] = [];
  readonly cancelledJobs: string[] = [];
  private sandboxes = new Map<string, VirtualSandbox>();
  private nextId = 1;

  capabilities(): SandboxCapabilities {
    return {
      snapshot: "none",
      persistentWorkspace: false,
      tunnels: false,
      warmPool: false,
      hibernation: true,
      customImage: false,
      coldStartEstimateMs: 0,
    };
  }

  async create(): Promise<Sandbox> {
    const sb = new VirtualSandbox(`lrt-${this.nextId++}`);
    const cancelled = this.cancelledJobs;
    sb.cancelJob = async (execId: string) => {
      cancelled.push(execId);
    };
    this.sandboxes.set(sb.id, sb);
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

  async resume(): Promise<void> {}
}

let api: TestApi | undefined;
let unregister: (() => void) | undefined;

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "fixture-key");
  const faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
  unregister = () => faux.unregister();
  faux.appendResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("Noted.")));
});

afterEach(async () => {
  unregister?.();
  unregister = undefined;
  await api?.cleanup();
  api = undefined;
  vi.unstubAllEnvs();
});

async function seedSession(
  t: TestApi,
  id: string,
  owner: { type: "user" | "team"; id: string } = { type: "user", id: "local-user" },
  userId = "local-user",
): Promise<void> {
  const now = Date.now();
  await t.providers.db.insert(agentSessions).values({
    id,
    userId,
    orgId: "local-org",
    workspace: `/tmp/wakeups-route-${id}`,
    status: "active",
    ownerType: owner.type,
    ownerId: owner.id,
    createdAt: now,
    updatedAt: now,
  });
}

async function warmSession(t: TestApi, id: string) {
  const session = await t.providers.engineHost.sessionFor(id, {
    userId: "local-user",
    orgId: "local-org",
    workspace: `/tmp/wakeups-route-${id}`,
  });
  await session.attachment.ensureReady({ timeoutMs: 5_000 });
  return session;
}

/** Seeds a running process wakeup and its lease on `threadId`. */
async function seedProcess(
  t: TestApi,
  sessionId: string,
  threadId: string,
  n: number,
  sandboxId?: string,
): Promise<{ wakeup: Wakeup; lease: Lease }> {
  const now = Date.now();
  const lease: Lease = {
    id: `ls_proc${n}`,
    sessionId,
    sandboxId,
    ownerKind: "process",
    ownerId: `wk_proc${n}`,
    threadId,
    reason: `full proof build ${n}`,
    createdAt: now,
    deadlineAt: now + 48 * HOUR_MS,
  };
  const wakeup: Wakeup = {
    id: `wk_proc${n}`,
    sessionId,
    threadId,
    kind: "process",
    status: "running",
    reason: `full proof build ${n}`,
    command: "lake build",
    execId: `job-test-${n}`,
    leaseId: lease.id,
    deadlineAt: lease.deadlineAt,
    logOffset: 0,
    logTail: "building 41/90",
    eventCount: 0,
    createdAt: now - 60_000,
    updatedAt: now,
  };
  await t.providers.engineStore.createWakeupWithLease(wakeup, lease);
  return { wakeup, lease };
}

async function seedTimer(t: TestApi, sessionId: string, threadId: string, n: number): Promise<Wakeup> {
  const now = Date.now();
  const wakeup: Wakeup = {
    id: `wk_timer${n}`,
    sessionId,
    threadId,
    kind: "timer",
    status: "pending",
    reason: "check CI",
    prompt: "check CI",
    fireAt: now + 2 * HOUR_MS,
    logOffset: 0,
    logTail: "",
    eventCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  await t.providers.engineStore.createWakeup(wakeup);
  return wakeup;
}

async function seedHold(t: TestApi, sessionId: string, threadId: string, n: number): Promise<Lease> {
  const now = Date.now();
  const lease: Lease = {
    id: `ls_hold${n}`,
    sessionId,
    sandboxId: "lrt-1",
    ownerKind: "hold",
    threadId,
    reason: "terminal work",
    createdAt: now,
    deadlineAt: now + 4 * HOUR_MS,
  };
  await t.providers.engineStore.createLease(lease);
  return lease;
}

function post(t: TestApi, path: string, body?: unknown) {
  return fetch(`${t.baseUrl}${path}`, {
    method: "POST",
    ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
}

describe("GET /api/sessions/:id/wakeups", () => {
  it("lists open wakeups and active leases without the command or exec id", async () => {
    api = await bootTestApi();
    await seedSession(api, "wk-list");
    const session = await api.providers.engineHost.sessionFor("wk-list", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/wakeups-route-wk-list",
    });
    const thread = await session.ensureDefaultThread();
    await seedProcess(api, "wk-list", thread.id, 1);
    await seedTimer(api, "wk-list", thread.id, 1);

    const res = await fetch(`${api.baseUrl}/api/sessions/wk-list/wakeups`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListSessionWakeupsResponse;
    expect(body.wakeups.map((w) => w.id).sort()).toEqual(["wk_proc1", "wk_timer1"]);
    const proc = body.wakeups.find((w) => w.id === "wk_proc1");
    expect(proc).toMatchObject({ kind: "process", status: "running", reason: "full proof build 1", threadId: thread.id });
    expect(proc && "command" in proc).toBe(false);
    expect(proc && "execId" in proc).toBe(false);
    expect(body.leases).toEqual([
      expect.objectContaining({ id: "ls_proc1", ownerKind: "process", ownerId: "wk_proc1" }),
    ]);
  });

  it("404s for a session the caller cannot view", async () => {
    api = await bootTestApi();
    await seedSession(api, "wk-list-other", { type: "user", id: "test-member" }, "test-member");
    const res = await fetch(`${api.baseUrl}/api/sessions/wk-list-other/wakeups`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/sessions/:id/wakeups/:wakeupId/cancel", () => {
  it("cancels a process as a person and signals its thread with cause=cancelled", async () => {
    const provider = new LeaseTestProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    await seedSession(api, "wk-cancel");
    const session = await warmSession(api, "wk-cancel");
    const thread = await session.ensureDefaultThread();
    await seedProcess(api, "wk-cancel", thread.id, 1, session.attachment.sandboxId);

    const res = await post(api, "/api/sessions/wk-cancel/wakeups/wk_proc1/cancel");
    expect(res.status).toBe(200);
    expect((await res.json()) as CancelSessionWakeupResponse).toEqual({ cancelled: { id: "wk_proc1", kind: "process" } });

    const store = api.providers.engineStore;
    expect(await store.getWakeup("wk_proc1")).toMatchObject({ status: "cancelled", cause: "cancelled" });
    expect(await store.countActiveLeases("wk-cancel")).toBe(0);
    expect(provider.cancelledJobs).toEqual(["job-test-1"]);

    const item = await store.getQueueItemByDispatchId("wk-cancel", "wakeup:wk_proc1:terminal");
    expect(item?.threadId).toBe(thread.id);
    const content = item?.content;
    expect(typeof content === "object" && content !== null && "kind" in content && content.kind === "signal").toBe(true);
    if (typeof content === "object" && content !== null && "kind" in content && content.kind === "signal") {
      expect(content.signalType).toBe("process.exited");
      expect(content.tagName).toBe("wakeup");
      expect(content.attributes).toMatchObject({ cause: "cancelled", cancelledBy: "user:local-user", wakeupId: "wk_proc1" });
      expect(content.body).toContain("A person stopped this process");
      expect(content.body).toContain("building 41/90");
    }
  });

  it("releases a hold and 404s a second cancel of the same id", async () => {
    const provider = new LeaseTestProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    await seedSession(api, "wk-hold");
    const session = await warmSession(api, "wk-hold");
    const thread = await session.ensureDefaultThread();
    await seedHold(api, "wk-hold", thread.id, 1);

    const first = await post(api, "/api/sessions/wk-hold/wakeups/ls_hold1/cancel");
    expect(first.status).toBe(200);
    expect((await first.json()) as CancelSessionWakeupResponse).toEqual({ cancelled: { id: "ls_hold1", kind: "hold" } });
    const item = await api.providers.engineStore.getQueueItemByDispatchId("wk-hold", "lease:ls_hold1:released");
    expect(item).not.toBeNull();

    const second = await post(api, "/api/sessions/wk-hold/wakeups/ls_hold1/cancel");
    expect(second.status).toBe(404);
    expect(((await second.json()) as { error: string }).error).toContain("Reload the list");
  });

  it("404s for a caller who may not administer the session, and cancels nothing", async () => {
    api = await bootTestApi();
    await seedTeam(api, "team_wk", [{ userId: "test-member", role: "member" }]);
    await seedSession(api, "wk-member", { type: "team", id: "team_wk" }, "test-member");
    const session = await api.providers.engineHost.sessionFor("wk-member", {
      userId: "test-member",
      orgId: "local-org",
      workspace: "/tmp/wakeups-route-wk-member",
    });
    const thread = await session.ensureDefaultThread();
    await seedTimer(api, "wk-member", thread.id, 1);
    const asMember = { "x-valet-test-user-id": "test-member" };

    // A team member may view the work but may not stop it.
    const listed = await fetch(`${api.baseUrl}/api/sessions/wk-member/wakeups`, { headers: asMember });
    expect(listed.status).toBe(200);
    const res = await fetch(`${api.baseUrl}/api/sessions/wk-member/wakeups/wk_timer1/cancel`, {
      method: "POST",
      headers: asMember,
    });
    expect(res.status).toBe(404);
    expect(await api.providers.engineStore.getWakeup("wk_timer1")).toMatchObject({ status: "pending" });
  });
});

async function seedTeam(t: TestApi, id: string, members: Array<{ userId: string; role: "admin" | "member" }>): Promise<void> {
  await t.providers.db.insert(teams).values({
    id,
    orgId: "local-org",
    name: `Team ${id}`,
    origin: "local",
    externalId: null,
    createdAt: Date.now(),
  });
  for (const m of members) {
    await t.providers.db.insert(teamMembers).values({ teamId: id, userId: m.userId, role: m.role });
  }
}

describe("pause and replace honor leases (B8)", () => {
  it("pause 409s naming the work, then force=true cancels it, suspends, and signals", async () => {
    const provider = new LeaseTestProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    await seedSession(api, "wk-pause");
    const session = await warmSession(api, "wk-pause");
    const thread = await session.ensureDefaultThread();
    const { lease } = await seedProcess(api, "wk-pause", thread.id, 1, session.attachment.sandboxId);
    await seedTimer(api, "wk-pause", thread.id, 2);

    const refused = await post(api, "/api/sessions/wk-pause/pause");
    expect(refused.status).toBe(409);
    expect((await refused.json()) as { error: string }).toEqual({
      error: `This session has active background work: wk_proc1 "full proof build 1" (deadline ${new Date(lease.deadlineAt).toISOString()}). Ask the agent to cancel it, or send force=true to stop it.`,
    });
    expect(provider.suspendCalls).toEqual([]);

    const forced = await post(api, "/api/sessions/wk-pause/pause?force=true");
    expect(forced.status).toBe(200);
    expect((await forced.json()) as PauseSessionResponse).toEqual({ status: "hibernated", cancelledWork: ["wk_proc1"] });
    expect(provider.suspendCalls.length).toBe(1);

    const store = api.providers.engineStore;
    expect(await store.getWakeup("wk_proc1")).toMatchObject({ status: "cancelled", cause: "cancelled" });
    // A timer does not use the sandbox, so a pause leaves it scheduled.
    expect(await store.getWakeup("wk_timer2")).toMatchObject({ status: "pending" });
    const item = await store.getQueueItemByDispatchId("wk-pause", "wakeup:wk_proc1:terminal");
    const content = item?.content;
    if (typeof content === "object" && content !== null && "kind" in content && content.kind === "signal") {
      expect(content.body).toContain("They paused the session.");
    } else {
      throw new Error("the pause sent no process.exited signal");
    }
  });

  it("replace 409s under a lease, and force in the body stops the work first", async () => {
    const provider = new LeaseTestProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    await seedSession(api, "wk-replace");
    const session = await warmSession(api, "wk-replace");
    const thread = await session.ensureDefaultThread();
    await seedHold(api, "wk-replace", thread.id, 1);

    const refused = await post(api, "/api/sessions/wk-replace/sandbox/replace");
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain('ls_hold1 "terminal work"');

    const forced = await post(api, "/api/sessions/wk-replace/sandbox/replace", { force: true });
    expect(forced.status).toBe(200);
    expect(await forced.json()).toEqual({ ok: true, cancelledWork: ["ls_hold1"] });
    expect(await api.providers.engineStore.countActiveLeases("wk-replace")).toBe(0);
  });
});

describe("thread archive cancels the thread's background work (H7)", () => {
  it("cancels the archived thread's wakeups and holds, sends no signal, and leaves other threads alone", async () => {
    const provider = new LeaseTestProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    await seedSession(api, "wk-archive");
    const session = await warmSession(api, "wk-archive");
    const main = await session.ensureDefaultThread();
    const side = await session.createThread("web:side");
    await seedProcess(api, "wk-archive", side.id, 1, session.attachment.sandboxId);
    await seedHold(api, "wk-archive", side.id, 1);
    await seedTimer(api, "wk-archive", main.id, 2);

    const res = await fetch(`${api.baseUrl}/api/sessions/wk-archive/threads/${side.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    expect(res.status).toBe(200);

    const store = api.providers.engineStore;
    expect(await store.getWakeup("wk_proc1")).toMatchObject({ status: "cancelled", cause: "cancelled" });
    expect(await store.countActiveLeases("wk-archive")).toBe(0);
    expect(await store.getWakeup("wk_timer2")).toMatchObject({ status: "pending" });
    expect(await store.getQueueItemByDispatchId("wk-archive", "wakeup:wk_proc1:terminal")).toBeNull();
    expect(await store.getQueueItemByDispatchId("wk-archive", "lease:ls_hold1:released")).toBeNull();
  });
});

describe("owner move cancels background work (H11)", () => {
  it("cancels every open wakeup and hold with no signal and returns the count", async () => {
    api = await bootTestApi();
    await seedTeam(api, "team_mv_wk", [{ userId: "local-user", role: "admin" }]);
    await seedSession(api, "wk-move");
    const session = await api.providers.engineHost.sessionFor("wk-move", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/wakeups-route-wk-move",
    });
    const thread = await session.ensureDefaultThread();
    await seedTimer(api, "wk-move", thread.id, 1);
    await seedHold(api, "wk-move", thread.id, 1);

    const res = await fetch(`${api.baseUrl}/api/sessions/wk-move`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamId: "team_mv_wk" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as PatchSessionResponse).cancelledWorkCount).toBe(2);

    const store = api.providers.engineStore;
    expect(await store.getWakeup("wk_timer1")).toMatchObject({ status: "cancelled" });
    expect(await store.countActiveLeases("wk-move")).toBe(0);
    expect(await store.getQueueItemByDispatchId("wk-move", "wakeup:wk_timer1:terminal")).toBeNull();
    const rows = await api.providers.db.select().from(agentSessions).where(eq(agentSessions.id, "wk-move"));
    expect(rows[0]?.ownerType).toBe("team");
  });

  it("a move with no background work reports no count", async () => {
    api = await bootTestApi();
    await seedTeam(api, "team_mv_none", [{ userId: "local-user", role: "admin" }]);
    await seedSession(api, "wk-move-none");
    const res = await fetch(`${api.baseUrl}/api/sessions/wk-move-none`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamId: "team_mv_none" }),
    });
    expect(res.status).toBe(200);
    expect("cancelledWorkCount" in ((await res.json()) as PatchSessionResponse)).toBe(false);
  });
});
