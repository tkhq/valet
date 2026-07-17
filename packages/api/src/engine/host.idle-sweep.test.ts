/**
 * Sandbox hibernation plan, Task 3: `EngineHost`'s idle sweep. Everything
 * here runs against in-memory engine providers (`InMemorySessionStore` +
 * friends) rather than `bootTestApi`'s full PGlite/HTTP boot — the sweep is
 * a pure function of (cache, store, attachment state, clock), and
 * constructing `EngineHost` directly means `vi.useFakeTimers()` can be
 * enabled BEFORE the host's constructor creates its `setInterval`, so the
 * whole test drives entirely off the fake clock with no reliance on wall
 * time.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryCredentialStore,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandbox,
  type QueueItem,
  type Sandbox,
  type SandboxCapabilities,
  type SandboxCreateOpts,
  type SandboxProvider,
  type SandboxStatus,
} from "@valet/engine";
import { EngineHost, type EngineHostOpts } from "./host.js";

/** Scripted `SandboxProvider`: implements the hibernation seam (suspend /
 * resume), records every call, and lets a test flip `hibernation` off to
 * exercise the capability-gated sweep. */
class HibernatingTestProvider implements SandboxProvider {
  readonly backend = "hib-test";
  readonly suspendCalls: string[] = [];
  readonly resumeCalls: string[] = [];
  hibernation = true;
  private sandboxes = new Map<string, VirtualSandbox>();
  private nextId = 1;

  capabilities(): SandboxCapabilities {
    return {
      snapshot: "none",
      persistentWorkspace: false,
      tunnels: false,
      warmPool: false,
      hibernation: this.hibernation,
      coldStartEstimateMs: 0,
    };
  }

  async create(_opts: SandboxCreateOpts): Promise<Sandbox> {
    const id = `hib-${this.nextId++}`;
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

function buildHost(
  store: InMemorySessionStore,
  provider: SandboxProvider,
  extra: Partial<EngineHostOpts> = {},
): EngineHost {
  return new EngineHost({
    engineStore: store,
    sandboxProvider: provider,
    eventStream: new InMemoryEventStream(),
    engineCredentials: new InMemoryCredentialStore(),
    ...extra,
  });
}

/** Creates a session and drives its attachment to `ready` (sandboxes are
 * lazy/first-touch — the sweep only ever acts on a `ready` attachment). */
async function buildReadySession(host: EngineHost, sessionId: string) {
  const session = await host.sessionFor(sessionId, { userId: "u1", orgId: "o1", workspace: "/tmp/idle-sweep" });
  await session.attachment.ensureReady({ timeoutMs: 5_000 });
  return session;
}

let nextItemId = 1;

/** Admits a queue item and immediately force-settles it, stamping
 * `latestActivityAt` at the CURRENT (possibly faked) clock value. */
async function stampActivity(store: InMemorySessionStore, sessionId: string, threadId: string): Promise<void> {
  const now = Date.now();
  await store.saveThread(sessionId, {
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
    content: "hi",
    status: "queued",
    attemptCount: 0,
    maxAttempts: 10,
    timeoutAt: now + 3_600_000,
    createdAt: now,
    updatedAt: now,
  };
  await store.admitSubmission(sessionId, threadId, item);
  await store.forceSettle(sessionId, item.id, "aborted");
}

/** Admits a queue item and leaves it unsettled (queued/running/gated). */
async function admitUnsettled(store: InMemorySessionStore, sessionId: string, threadId: string): Promise<void> {
  const now = Date.now();
  await store.saveThread(sessionId, {
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
  await store.admitSubmission(sessionId, threadId, item);
}

describe("EngineHost idle sweep", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("suspends a ready sandbox once it has been idle past idleMinutes", async () => {
    vi.useFakeTimers();
    const provider = new HibernatingTestProvider();
    const store = new InMemorySessionStore();
    const host = buildHost(store, provider, { idleMinutes: 1 });

    const sessionId = "s-idle";
    const session = await buildReadySession(host, sessionId);
    await stampActivity(store, sessionId, "th-idle");

    // idleMinutes: 1 => 60_000ms window; sweep cadence is also 60_000ms, so
    // two ticks are needed to clear the window (the tick landing exactly on
    // the boundary must NOT suspend).
    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.attachment.state).toBe("ready");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(session.attachment.state).toBe("suspended");
    expect(provider.suspendCalls.length).toBe(1);

    host.evictAll();
  });

  it("never suspends a session with unsettled submissions (running/queued/gated)", async () => {
    vi.useFakeTimers();
    const provider = new HibernatingTestProvider();
    const store = new InMemorySessionStore();
    const host = buildHost(store, provider, { idleMinutes: 1 });

    const sessionId = "s-running";
    const session = await buildReadySession(host, sessionId);
    await admitUnsettled(store, sessionId, "th-running");

    await vi.advanceTimersByTimeAsync(300_000);

    expect(provider.suspendCalls).toEqual([]);
    expect(session.attachment.state).toBe("ready");

    host.evictAll();
  });

  it("resets the idle clock on new activity", async () => {
    vi.useFakeTimers();
    const provider = new HibernatingTestProvider();
    const store = new InMemorySessionStore();
    const host = buildHost(store, provider, { idleMinutes: 1 });

    const sessionId = "s-reset";
    const session = await buildReadySession(host, sessionId);
    await stampActivity(store, sessionId, "th-reset");

    // Tick 1 @ +60s: sinceMs(0) sits exactly on the boundary — not idle yet.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.attachment.state).toBe("ready");

    // New activity right at the boundary resets the clock. Without this,
    // the ORIGINAL activity (t=0) would already be idle by tick 2 (+120s).
    await stampActivity(store, sessionId, "th-reset");

    // Tick 2 @ +120s: sinceMs(60_000) sits exactly on the new boundary —
    // still not idle.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.attachment.state).toBe("ready");

    // Tick 3 @ +180s: now 120s past the reset activity — idle, suspends.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.attachment.state).toBe("suspended");

    host.evictAll();
  });

  it("a submission admitted during the race window wins — suspend is skipped", async () => {
    vi.useFakeTimers();
    const provider = new HibernatingTestProvider();
    const store = new InMemorySessionStore();
    let hookCalls = 0;
    const host = buildHost(store, provider, {
      idleMinutes: 1,
      idleSweepTestHooks: {
        beforeSuspend: async (sessionId) => {
          hookCalls++;
          await admitUnsettled(store, sessionId, "th-race");
        },
      },
    });

    const sessionId = "s-race";
    const session = await buildReadySession(host, sessionId);
    await stampActivity(store, sessionId, "th-race-initial");

    await vi.advanceTimersByTimeAsync(120_000);

    expect(hookCalls).toBe(1);
    expect(provider.suspendCalls).toEqual([]);
    expect(session.attachment.state).toBe("ready");

    host.evictAll();
  });

  it("never starts the sweep when the provider lacks hibernation capability", async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const provider = new HibernatingTestProvider();
    provider.hibernation = false;
    const store = new InMemorySessionStore();
    const host = buildHost(store, provider, { idleMinutes: 1 });

    expect(setIntervalSpy).not.toHaveBeenCalled();

    const sessionId = "s-nocap";
    const session = await buildReadySession(host, sessionId);
    await stampActivity(store, sessionId, "th-nocap");

    await vi.advanceTimersByTimeAsync(600_000);

    expect(session.attachment.state).toBe("ready");
    expect(provider.suspendCalls).toEqual([]);

    setIntervalSpy.mockRestore();
    host.evictAll();
  });

  it("never starts the sweep when idleMinutes is 0 (or unset)", () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const provider = new HibernatingTestProvider();
    const store = new InMemorySessionStore();

    const hostZero = buildHost(store, provider, { idleMinutes: 0 });
    expect(setIntervalSpy).not.toHaveBeenCalled();
    hostZero.evictAll();

    const hostUnset = buildHost(store, provider);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    hostUnset.evictAll();

    setIntervalSpy.mockRestore();
  });

  it("invokes onHibernate after a successful suspend and onWake on the next ready", async () => {
    vi.useFakeTimers();
    const provider = new HibernatingTestProvider();
    const store = new InMemorySessionStore();
    const hibernated: string[] = [];
    const woke: string[] = [];
    const host = buildHost(store, provider, {
      idleMinutes: 1,
      onHibernate: (id) => {
        hibernated.push(id);
      },
      onWake: (id) => {
        woke.push(id);
      },
    });

    const sessionId = "s-wake";
    const session = await buildReadySession(host, sessionId);
    await stampActivity(store, sessionId, "th-wake");

    await vi.advanceTimersByTimeAsync(120_000);
    expect(session.attachment.state).toBe("suspended");
    expect(hibernated).toEqual([sessionId]);
    expect(woke).toEqual([]);

    await session.attachment.ensureReady({ timeoutMs: 5_000 });
    expect(session.attachment.state).toBe("ready");
    expect(woke).toEqual([sessionId]);

    host.evictAll();
  });
});
