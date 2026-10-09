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
  type ChannelOrigin,
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
import { agentSessions, sessionThreads, teamMembers, teams } from "../schema/index.js";
import type {
  BackgroundWorkConflict,
  CancelSessionWakeupResponse,
  ListSessionWakeupsResponse,
  PatchSessionResponse,
  PatchThreadResponse,
  PauseSessionResponse,
} from "../wire/types.js";

const HOUR_MS = 3_600_000;

/** A hibernation-capable provider whose sandboxes record job cancels. */
class LeaseTestProvider implements SandboxProvider {
  readonly backend = "lease-route-test";
  readonly suspendCalls: string[] = [];
  readonly cancelledJobs: string[] = [];
  /** Runs inside each job cancel. A test uses it to start a turn mid-cancel. */
  onCancel: (() => Promise<void>) | undefined;
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
      await this.onCancel?.();
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
  origin?: ChannelOrigin,
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
    ...(origin !== undefined ? { origin } : {}),
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
    const conflict = (await refused.json()) as BackgroundWorkConflict;
    expect(conflict).toEqual({
      error: `This session has background work running: "full proof build 1" (process, deadline ${new Date(lease.deadlineAt).toISOString()}). Cancel it first, or retry with force=true to stop it and pause the session.`,
      code: "background_work",
      work: [expect.objectContaining({ id: "wk_proc1", kind: "process", reason: "full proof build 1", threadId: thread.id })],
      hiddenCount: 0,
      forceAllowed: true,
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
    const conflict = (await refused.json()) as BackgroundWorkConflict;
    expect(conflict.error).toContain('"terminal work" (hold, deadline');
    expect(conflict.work.map((w) => w.id)).toEqual(["ls_hold1"]);

    const forced = await post(api, "/api/sessions/wk-replace/sandbox/replace", { force: true });
    expect(forced.status).toBe(200);
    expect(await forced.json()).toEqual({ ok: true, cancelledWork: ["ls_hold1"] });
    expect(await api.providers.engineStore.countActiveLeases("wk-replace")).toBe(0);
  });
});

describe("forced pause and replace ordering (fix wave 3)", () => {
  it("a forced pause of a sandbox that is not ready (api restart) cancels nothing", async () => {
    const provider = new LeaseTestProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    await seedSession(api, "wk-detached");
    // After an api restart the session rebuilds `detached` until a turn uses the sandbox.
    const session = await api.providers.engineHost.sessionFor("wk-detached", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/wakeups-route-wk-detached",
    });
    const thread = await session.ensureDefaultThread();
    await seedProcess(api, "wk-detached", thread.id, 1, "lrt-gone");
    expect(session.attachment.state).toBe("detached");

    const res = await post(api, "/api/sessions/wk-detached/pause?force=true");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "The sandbox is not attached yet. Send a message in the session, then pause again.",
    );
    expect(await api.providers.engineStore.getWakeup("wk_proc1")).toMatchObject({ status: "running" });
    expect(provider.cancelledJobs).toEqual([]);
    expect(await api.providers.engineStore.getQueueItemByDispatchId("wk-detached", "wakeup:wk_proc1:terminal")).toBeNull();
  });

  it("a pause of a sandbox that is not attached says so before it names any work (fix wave 4, N7)", async () => {
    const provider = new LeaseTestProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    await seedSession(api, "wk-detached-plain");
    const session = await api.providers.engineHost.sessionFor("wk-detached-plain", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/wakeups-route-wk-detached-plain",
    });
    const thread = await session.ensureDefaultThread();
    await seedProcess(api, "wk-detached-plain", thread.id, 1, "lrt-gone");

    const res = await post(api, "/api/sessions/wk-detached-plain/pause");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.code).toBeUndefined();
    expect(body.error).toBe("The sandbox is not attached yet. Send a message in the session, then pause again.");
  });

  it("work that starts during a forced pause stops the pause, and the signals still go out (fix wave 4, N5)", async () => {
    const provider = new LeaseTestProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    await seedSession(api, "wk-lease-race");
    const session = await warmSession(api, "wk-lease-race");
    const thread = await session.ensureDefaultThread();
    await seedProcess(api, "wk-lease-race", thread.id, 1, session.attachment.sandboxId);
    const t = api;
    provider.onCancel = async () => {
      provider.onCancel = undefined;
      await seedHold(t, "wk-lease-race", thread.id, 9);
    };

    const res = await post(api, "/api/sessions/wk-lease-race/pause?force=true");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("The background work already stopped.");
    expect(provider.suspendCalls).toEqual([]);
    expect(await api.providers.engineStore.getWakeup("wk_proc1")).toMatchObject({ status: "cancelled" });
    expect(await api.providers.engineStore.getQueueItemByDispatchId("wk-lease-race", "wakeup:wk_proc1:terminal")).not.toBeNull();
    expect(await api.providers.engineStore.countActiveLeases("wk-lease-race")).toBe(1);
  });

  it("a lease created while a replace builds the session stops the replace (fix wave 4, N5)", async () => {
    const provider = new LeaseTestProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    await seedSession(api, "wk-replace-race");
    const session = await warmSession(api, "wk-replace-race");
    const thread = await session.ensureDefaultThread();
    const sandboxBefore = session.attachment.sandboxId;
    const host = api.providers.engineHost;
    const original = host.sessionFor.bind(host);
    const t = api;
    const spy = vi.spyOn(host, "sessionFor").mockImplementation(async (...args) => {
      spy.mockRestore();
      const built = await original(...args);
      await seedHold(t, "wk-replace-race", thread.id, 9);
      return built;
    });

    const res = await post(api, "/api/sessions/wk-replace-race/sandbox/replace");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("background work started");
    expect(session.attachment.sandboxId).toBe(sandboxBefore);
  });

  it("a turn that starts during a forced pause stops the pause, and the signals still go out", async () => {
    const provider = new LeaseTestProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    await seedSession(api, "wk-race");
    const session = await warmSession(api, "wk-race");
    const thread = await session.ensureDefaultThread();
    await seedProcess(api, "wk-race", thread.id, 1, session.attachment.sandboxId);
    provider.onCancel = async () => {
      provider.onCancel = undefined;
      await session.prompt("are you there?", { threadId: thread.id });
    };

    const res = await post(api, "/api/sessions/wk-race/pause?force=true");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("a turn started");
    expect(provider.suspendCalls).toEqual([]);
    expect(await api.providers.engineStore.getWakeup("wk_proc1")).toMatchObject({ status: "cancelled" });
    expect(await api.providers.engineStore.getQueueItemByDispatchId("wk-race", "wakeup:wk_proc1:terminal")).not.toBeNull();
  });
});

describe("team visibility of the background-work refusal (fix wave 3, M2, L1, L2)", () => {
  it("names only visible work, counts hidden work, and refuses force while hidden work exists", async () => {
    const provider = new LeaseTestProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    await seedTeam(api, "team_vis", [
      { userId: "local-user", role: "admin" },
      { userId: "test-member", role: "member" },
    ]);
    await seedSession(api, "wk-vis", { type: "team", id: "team_vis" });
    const session = await warmSession(api, "wk-vis");
    const main = await session.ensureDefaultThread();
    const hidden = await session.createThread("app-assistant:test-member");
    await seedProcess(api, "wk-vis", main.id, 1, session.attachment.sandboxId);
    await seedProcess(api, "wk-vis", hidden.id, 2, session.attachment.sandboxId);

    const refused = await post(api, "/api/sessions/wk-vis/pause");
    expect(refused.status).toBe(409);
    const conflict = (await refused.json()) as BackgroundWorkConflict;
    expect(conflict.work.map((w) => w.id)).toEqual(["wk_proc1"]);
    expect(conflict.hiddenCount).toBe(1);
    expect(conflict.forceAllowed).toBe(false);
    expect(conflict.error).not.toContain("full proof build 2");
    expect(conflict.error).toContain("1 item runs on threads you cannot see");

    const forced = await post(api, "/api/sessions/wk-vis/pause?force=true");
    expect(forced.status).toBe(409);
    expect(((await forced.json()) as BackgroundWorkConflict).forceAllowed).toBe(false);
    expect(provider.suspendCalls).toEqual([]);
    expect(provider.cancelledJobs).toEqual([]);
    expect(await api.providers.engineStore.getWakeup("wk_proc1")).toMatchObject({ status: "running" });
  });
});

describe("profile change honors leases (fix wave 3, M3)", () => {
  it("409s a profile change that would replace a leased sandbox, and force stops the work first", async () => {
    const provider = new LeaseTestProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    await seedSession(api, "wk-profile");
    const session = await warmSession(api, "wk-profile");
    const thread = await session.ensureDefaultThread();
    await seedProcess(api, "wk-profile", thread.id, 1, session.attachment.sandboxId);
    await seedTimer(api, "wk-profile", thread.id, 2);
    const patch = (body: unknown) =>
      fetch(`${api?.baseUrl}/api/sessions/wk-profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const refused = await patch({ profile: "full" });
    expect(refused.status).toBe(409);
    const conflict = (await refused.json()) as BackgroundWorkConflict;
    expect(conflict.work.map((w) => w.id)).toEqual(["wk_proc1"]);
    expect(conflict.error).toContain("to stop it and change the profile");
    const store = api.providers.engineStore;
    expect(await store.getWakeup("wk_proc1")).toMatchObject({ status: "running" });
    const unchanged = await api.providers.db.select().from(agentSessions).where(eq(agentSessions.id, "wk-profile"));
    expect(unchanged[0]?.profile).not.toBe("full");

    const forced = await patch({ profile: "full", force: true });
    expect(forced.status).toBe(200);
    expect(((await forced.json()) as PatchSessionResponse).cancelledWork).toEqual(["wk_proc1"]);
    expect(await store.getWakeup("wk_proc1")).toMatchObject({ status: "cancelled" });
    // A timer does not use the sandbox, so it keeps its schedule.
    expect(await store.getWakeup("wk_timer2")).toMatchObject({ status: "pending" });
    expect(await store.getQueueItemByDispatchId("wk-profile", "wakeup:wk_proc1:terminal")).not.toBeNull();
  });
});

describe("thread archive refuses while the thread has background work (fix wave 3, H1)", () => {
  it("409s naming the work, then force stops it and tells the agent on the main thread", async () => {
    const provider = new LeaseTestProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    await seedSession(api, "wk-archive");
    const session = await warmSession(api, "wk-archive");
    const main = await session.ensureDefaultThread();
    const side = await session.createThread("web:side");
    await seedProcess(api, "wk-archive", side.id, 1, session.attachment.sandboxId);
    await seedHold(api, "wk-archive", side.id, 1);
    await seedTimer(api, "wk-archive", main.id, 2);
    const patch = (body: unknown) =>
      fetch(`${api?.baseUrl}/api/sessions/wk-archive/threads/${side.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const refused = await patch({ archived: true });
    expect(refused.status).toBe(409);
    const conflict = (await refused.json()) as BackgroundWorkConflict;
    expect(conflict.work.map((w) => w.id).sort()).toEqual(["ls_hold1", "wk_proc1"]);
    expect(conflict.error).toContain('This thread has background work running: "full proof build 1"');
    expect(conflict.error).toContain("retry with force=true to stop it and archive the thread");
    const store = api.providers.engineStore;
    expect(await store.getWakeup("wk_proc1")).toMatchObject({ status: "running" });

    const res = await patch({ archived: true, force: true });
    expect(res.status).toBe(200);
    const archived = (await res.json()) as PatchThreadResponse;
    expect(archived.archivedAt).toBeDefined();
    expect(archived.cancelledWork?.sort()).toEqual(["ls_hold1", "wk_proc1"]);

    expect(await store.getWakeup("wk_proc1")).toMatchObject({ status: "cancelled", cause: "cancelled" });
    expect(await store.countActiveLeases("wk-archive")).toBe(0);
    expect(await store.getWakeup("wk_timer2")).toMatchObject({ status: "pending" });
    // The signal lands on the main thread, not the archived one.
    const item = await store.getQueueItemByDispatchId("wk-archive", "wakeup:wk_proc1:terminal");
    expect(item?.threadId).toBe(main.id);
    const content = item?.content;
    if (typeof content === "object" && content !== null && "kind" in content && content.kind === "signal") {
      expect(content.body).toContain("They archived the thread it ran in.");
    } else {
      throw new Error("the archive sent no process.exited signal");
    }
    expect((await store.getQueueItemByDispatchId("wk-archive", "lease:ls_hold1:released"))?.threadId).toBe(main.id);
  });
});

describe("owner move stops background work only on force (H11, fix wave 3 H2)", () => {
  it("409s naming the work, then force cancels it, signals the agent, and returns the count", async () => {
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
    const patch = (body: unknown) =>
      fetch(`${api?.baseUrl}/api/sessions/wk-move`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const refused = await patch({ teamId: "team_mv_wk" });
    expect(refused.status).toBe(409);
    const conflict = (await refused.json()) as BackgroundWorkConflict;
    expect(conflict.code).toBe("background_work");
    expect(conflict.work.map((w) => w.id).sort()).toEqual(["ls_hold1", "wk_timer1"]);
    expect(conflict.error).toContain("retry with force=true to stop it and move the session");
    const store = api.providers.engineStore;
    expect(await store.getWakeup("wk_timer1")).toMatchObject({ status: "pending" });
    const before = await api.providers.db.select().from(agentSessions).where(eq(agentSessions.id, "wk-move"));
    expect(before[0]?.ownerType).toBe("user");

    const res = await patch({ teamId: "team_mv_wk", force: true });
    expect(res.status).toBe(200);
    const moved = (await res.json()) as PatchSessionResponse;
    expect(moved.cancelledWorkCount).toBe(2);
    expect(moved.cancelledWork?.sort()).toEqual(["ls_hold1", "wk_timer1"]);

    expect(await store.getWakeup("wk_timer1")).toMatchObject({ status: "cancelled" });
    expect(await store.countActiveLeases("wk-move")).toBe(0);
    // The agent learns a person stopped the work, attributed to the mover.
    const item = await store.getQueueItemByDispatchId("wk-move", "wakeup:wk_timer1:terminal");
    const content = item?.content;
    if (typeof content === "object" && content !== null && "kind" in content && content.kind === "signal") {
      expect(content.signalType).toBe("timer.cancelled");
      expect(content.attributes).toMatchObject({ cancelledBy: "user:local-user" });
      // The route's note reaches a timer too (fix wave 4, N15).
      expect(content.body).toContain("They moved the session to another workspace.");
    } else {
      throw new Error("the move sent no timer.cancelled signal");
    }
    expect(await store.getQueueItemByDispatchId("wk-move", "lease:ls_hold1:released")).not.toBeNull();
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

describe("forced archive of a private thread keeps its details off the main thread (fix wave 4, N3)", () => {
  it("sends no log tail and no origin to the main thread, and notes the stop on the archived thread", async () => {
    const provider = new LeaseTestProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    await seedTeam(api, "team_arch", [
      { userId: "local-user", role: "admin" },
      { userId: "test-member", role: "member" },
    ]);
    await seedSession(api, "wk-arch-private", { type: "team", id: "team_arch" });
    const session = await warmSession(api, "wk-arch-private");
    const main = await session.ensureDefaultThread();
    const priv = await session.createThread("app-assistant:local-user");
    await seedProcess(api, "wk-arch-private", priv.id, 1, session.attachment.sandboxId, {
      channelType: "slack",
      threadKey: "slack:C123:1700000000.000100",
    });

    const res = await fetch(`${api.baseUrl}/api/sessions/wk-arch-private/threads/${priv.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true, force: true }),
    });
    expect(res.status).toBe(200);

    const store = api.providers.engineStore;
    const item = await store.getQueueItemByDispatchId("wk-arch-private", "wakeup:wk_proc1:terminal");
    expect(item?.threadId).toBe(main.id);
    const content = item?.content;
    if (typeof content === "object" && content !== null && "kind" in content && content.kind === "signal") {
      expect(content.body).toContain("They archived the thread it ran in.");
      expect(content.body).not.toContain("Last output");
      expect(content.body).not.toContain("building 41/90");
      expect(content.origin).toBeUndefined();
      expect(content.attributes).toMatchObject({ reason: "full proof build 1", cause: "cancelled" });
    } else {
      throw new Error("the archive sent no process.exited signal");
    }

    const snapshot = await store.getThreadSnapshot("wk-arch-private", priv.id);
    const notes = (snapshot?.entries ?? []).flatMap((e) =>
      e.type === "message" && e.role === "system" && typeof e.content === "string" ? [e.content] : [],
    );
    expect(notes.some((n) => n.includes("full proof build 1") && n.includes("archived"))).toBe(true);
  });
});

describe("archive waits for a running turn in the thread (fix wave 4, P4)", () => {
  it("409s a plain archive while the thread has an unsettled submission", async () => {
    api = await bootTestApi();
    await seedSession(api, "wk-arch-busy");
    const session = await api.providers.engineHost.sessionFor("wk-arch-busy", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/wakeups-route-wk-arch-busy",
    });
    await session.ensureDefaultThread();
    const side = await session.createThread("web:busy");
    const now = Date.now();
    await api.providers.engineStore.admitSubmission("wk-arch-busy", side.id, {
      id: "q-arch-busy",
      threadId: side.id,
      content: "still going",
      status: "queued",
      attemptCount: 0,
      maxAttempts: 10,
      timeoutAt: now + HOUR_MS,
      createdAt: now,
      updatedAt: now,
    });

    const res = await fetch(`${api.baseUrl}/api/sessions/wk-arch-busy/threads/${side.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "A turn is running in this thread. Wait for it to finish, then archive.",
    );
    const rows = await api.providers.db.select().from(sessionThreads).where(eq(sessionThreads.id, side.id));
    expect(rows[0]?.archivedAt ?? null).toBeNull();
  });
});

describe("profile change gates leased work after an api restart (fix wave 4, R1)", () => {
  it("409s a profile change of a session that is not live but holds leased work", async () => {
    const provider = new LeaseTestProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    await seedSession(api, "wk-profile-cold");
    await seedProcess(api, "wk-profile-cold", "th-cold", 1, "lrt-old");
    expect(api.providers.engineHost.isLive("wk-profile-cold")).toBe(false);

    const res = await fetch(`${api.baseUrl}/api/sessions/wk-profile-cold`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "full" }),
    });
    expect(res.status).toBe(409);
    const conflict = (await res.json()) as BackgroundWorkConflict;
    expect(conflict.work.map((w) => w.id)).toEqual(["wk_proc1"]);
    const rows = await api.providers.db.select().from(agentSessions).where(eq(agentSessions.id, "wk-profile-cold"));
    expect(rows[0]?.profile).not.toBe("full");
  });
});

describe("a hold with no thread is session-level work (fix wave 4, N4)", () => {
  it("an admin sees it, may force past it, and may cancel it; a member does not see it", async () => {
    const provider = new LeaseTestProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    await seedTeam(api, "team_nothread", [
      { userId: "local-user", role: "admin" },
      { userId: "test-member", role: "member" },
    ]);
    await seedSession(api, "wk-nothread", { type: "team", id: "team_nothread" });
    await warmSession(api, "wk-nothread");
    const now = Date.now();
    await api.providers.engineStore.createLease({
      id: "ls_nothread",
      sessionId: "wk-nothread",
      sandboxId: "lrt-1",
      ownerKind: "hold",
      reason: "legacy hold",
      createdAt: now,
      deadlineAt: now + 4 * HOUR_MS,
    });

    const listed = (await (await fetch(`${api.baseUrl}/api/sessions/wk-nothread/wakeups`)).json()) as ListSessionWakeupsResponse;
    expect(listed.leases.map((l) => l.id)).toEqual(["ls_nothread"]);
    const asMember = { "x-valet-test-user-id": "test-member" };
    const memberList = (await (
      await fetch(`${api.baseUrl}/api/sessions/wk-nothread/wakeups`, { headers: asMember })
    ).json()) as ListSessionWakeupsResponse;
    expect(memberList.leases).toEqual([]);

    const refused = await post(api, "/api/sessions/wk-nothread/pause");
    expect(refused.status).toBe(409);
    const conflict = (await refused.json()) as BackgroundWorkConflict;
    expect(conflict).toMatchObject({ hiddenCount: 0, forceAllowed: true });
    expect(conflict.work.map((w) => w.id)).toEqual(["ls_nothread"]);

    const cancelled = await post(api, "/api/sessions/wk-nothread/wakeups/ls_nothread/cancel");
    expect(cancelled.status).toBe(200);
    expect(await api.providers.engineStore.countActiveLeases("wk-nothread")).toBe(0);
  });
});

describe("refusal items carry their status (fix wave 4, N11)", () => {
  it("ships pending for a timer and running for a process", async () => {
    api = await bootTestApi();
    await seedTeam(api, "team_status", [{ userId: "local-user", role: "admin" }]);
    await seedSession(api, "wk-status");
    const session = await api.providers.engineHost.sessionFor("wk-status", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/wakeups-route-wk-status",
    });
    const thread = await session.ensureDefaultThread();
    await seedTimer(api, "wk-status", thread.id, 1);
    await seedProcess(api, "wk-status", thread.id, 2);

    const res = await fetch(`${api.baseUrl}/api/sessions/wk-status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamId: "team_status" }),
    });
    expect(res.status).toBe(409);
    const conflict = (await res.json()) as BackgroundWorkConflict;
    const status = Object.fromEntries(conflict.work.map((w) => [w.id, w.status]));
    expect(status).toEqual({ wk_timer1: "pending", wk_proc2: "running" });
  });
});
