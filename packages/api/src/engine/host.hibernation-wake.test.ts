/**
 * Sandbox hibernation plan, Task 4 — cross-restart hibernation-clear
 * regression test (review carry-forward from Task 3): `onWake` fires from
 * an IN-MEMORY `wasSuspended` flag on the attachment's status listener, so
 * it never fires for a session that hibernated, then had the api process
 * restart, then got rebuilt on its next touch — a rebuilt attachment starts
 * `detached` and reaches `ready` WITHOUT ever passing through `suspended`
 * in the new process's lifetime. This test simulates exactly that sequence
 * against a real app db (`agent_sessions`) and asserts `EngineHost`'s
 * `onSessionReady` hook (unconditional on every `ready`, unlike `onWake`)
 * clears the row back to `"active"` anyway.
 */
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  InMemoryCredentialStore,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandbox,
  type Sandbox,
  type SandboxCapabilities,
  type SandboxCreateOpts,
  type SandboxProvider,
  type SandboxStatus,
} from "@valet/engine";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { agentSessions } from "../schema/index.js";
import { buildHibernationHooks } from "./hibernation-hooks.js";
import { EngineHost } from "./host.js";

/** Minimal hibernation-capable provider — suspend/resume tracked but not
 * exercised by this test (the "restart" is simulated by dropping the
 * in-memory cache and building a fresh `EngineHost`, not by an actual
 * `suspend()` call, since the point under test is the DETACHED-then-ready
 * path, not the SUSPENDED-then-ready path `onWake` already covers). */
class TestProvider implements SandboxProvider {
  readonly backend = "hib-wake-test";
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

  async create(_opts: SandboxCreateOpts): Promise<Sandbox> {
    const id = `hibwake-${this.nextId++}`;
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

  async suspend(_id: string): Promise<void> {}
  async resume(_id: string): Promise<void> {}
}

describe("EngineHost cross-restart hibernation clear", () => {
  let testDb: TestPgDb | undefined;

  afterEach(async () => {
    await testDb?.cleanup();
    testDb = undefined;
  });

  it("clears status='hibernated' back to 'active' when a fresh host's rebuilt attachment reaches ready", async () => {
    testDb = await freshTestPgDb();
    const { appDb: db } = testDb;

    const sessionId = "s-cross-restart";
    const now = Date.now();
    await db.insert(agentSessions).values({
      id: sessionId,
      userId: "u1",
      orgId: "o1",
      workspace: "/tmp/cross-restart",
      status: "active",
      ownerType: "user",
      ownerId: "u1",
      createdAt: now,
      updatedAt: now,
    });

    // Shared "durable" engine store across both hosts — a real restart loses
    // the api process's in-memory EngineHost cache but NOT the underlying
    // (postgres-backed, in production) engine session data.
    const engineStore = new InMemorySessionStore();
    const provider = new TestProvider();

    // Host A: simulates the pre-restart process. Creates the session,
    // drives it ready, then `evictAll()` — dropping the cache WITHOUT
    // touching durable state, exactly like a process shutdown.
    const hostA = new EngineHost({
      engineStore,
      sandboxProvider: provider,
      eventStream: new InMemoryEventStream(),
      engineCredentials: new InMemoryCredentialStore(),
      db,
      ...buildHibernationHooks(db),
    });
    const sessionA = await hostA.sessionFor(sessionId, {
      userId: "u1",
      orgId: "o1",
      workspace: "/tmp/cross-restart",
    });
    await sessionA.attachment.ensureReady({ timeoutMs: 5_000 });
    hostA.evictAll();

    // Simulate: the session hibernated (via pause or the idle sweep) at
    // some point AFTER host A's cache was dropped (or the process crashed
    // before `onHibernate`'s write landed) — either way, by the time host B
    // boots, the row already reads `"hibernated"` with no live in-memory
    // attachment anywhere to have tracked a `suspended` transition.
    await db
      .update(agentSessions)
      .set({ status: "hibernated", updatedAt: Date.now() })
      .where(eq(agentSessions.id, sessionId));

    // Host B: simulates the post-restart process. A fresh EngineHost, empty
    // cache — `sessionFor` finds the existing engine session row and
    // restores it, which mints a BRAND NEW SandboxAttachment starting
    // `detached` (never `suspended` in this instance's lifetime).
    const hostB = new EngineHost({
      engineStore,
      sandboxProvider: provider,
      eventStream: new InMemoryEventStream(),
      engineCredentials: new InMemoryCredentialStore(),
      db,
      ...buildHibernationHooks(db),
    });
    const sessionB = await hostB.sessionFor(sessionId, {
      userId: "u1",
      orgId: "o1",
      workspace: "/tmp/cross-restart",
    });
    expect(sessionB.attachment.state).toBe("detached");

    await sessionB.attachment.ensureReady({ timeoutMs: 5_000 });
    expect(sessionB.attachment.state).toBe("ready");

    const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
    expect(rows[0]?.status).toBe("active");

    hostB.evictAll();
  });
});
