/**
 * Signal edge ACL matrix (Phase 4 Task 8, decision 16). Unit-level: drives
 * `admitSignal` directly against a real `bootTestApi()` stack (real db +
 * engine store + EngineHost) without any LLM involvement — every session
 * here is created/admitted without ever claiming a turn.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { admitSignal, SignalEdgeDeniedError, type AdmitSignalDeps } from "./signals.js";
import { agentSessions, eventDropLog } from "../schema/index.js";
import { defaultAssistantSessionFor } from "../test-helpers/assistant-session.js";
import type { OnePasswordService } from "../services/onepassword.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

function deps(a: TestApi): AdmitSignalDeps {
  return { db: a.providers.db, engineHost: a.providers.engineHost, engineStore: a.providers.engineStore };
}

describe("admitSignal edge ACL", () => {
  it("parent -> child is allowed and lands on the target thread", async () => {
    api = await bootTestApi();
    const parent = await api.providers.engineHost.sessionFor("parent-1", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const parentThread = parent.thread("web:default");
    const child = await api.providers.engineHost.childSessionFor("child-1", {
      parentSessionId: "parent-1",
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      orgId: "local-org",
      owner: { type: "user", id: "local-user" },
      workspace: "/tmp",
    });
    expect(child.options.parentSessionId).toBe("parent-1");

    const receipt = await admitSignal(deps(api), {
      from: { sessionId: "parent-1", owner: { type: "user", id: "local-user" } },
      to: "child-1",
      threadKey: "web:default",
      content: { kind: "signal", signalType: "orchestrator.message", body: "hello child" },
      dispatchId: "d-parent-to-child",
    });
    expect(receipt.status).toBeDefined();

    // Signal entries persist at turn claim (no LLM in this unit test), so
    // durable truth here is the admitted queue item: signal content + the
    // sender-namespaced dispatchId prove the admission went through the
    // engine's internal-sender stamping path.
    const item = await api.providers.engineStore.getQueueItem("child-1", receipt.queueItemId);
    expect(item).not.toBeNull();
    expect(item?.dispatchId).toBe("parent-1:d-parent-to-child");
    expect(item?.content).toMatchObject({ kind: "signal", signalType: "orchestrator.message" });
  });

  it("child -> parent is allowed", async () => {
    api = await bootTestApi();
    const parent = await api.providers.engineHost.sessionFor("parent-2", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const parentThread = parent.thread("web:default");
    await api.providers.engineHost.childSessionFor("child-2", {
      parentSessionId: "parent-2",
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      orgId: "local-org",
      owner: { type: "user", id: "local-user" },
      workspace: "/tmp",
    });

    const receipt = await admitSignal(deps(api), {
      from: { sessionId: "child-2", owner: { type: "user", id: "local-user" } },
      to: "parent-2",
      threadKey: parentThread.id,
      content: { kind: "signal", signalType: "child.settled", body: "done" },
      dispatchId: "d-child-to-parent",
    });
    expect(receipt.status).toBeDefined();
    // `threadKey` above was the parent thread's engine ID (not its key) —
    // the receipt landing on that exact thread proves resolveThread's
    // id-first path.
    expect(receipt.threadId).toBe(parentThread.id);

    const item = await api.providers.engineStore.getQueueItem("parent-2", receipt.queueItemId);
    expect(item).not.toBeNull();
    expect(item?.dispatchId).toBe("child-2:d-child-to-parent");
    expect(item?.content).toMatchObject({ kind: "signal", signalType: "child.settled" });
  });

  it("org -> user orchestrator (same org) is allowed", async () => {
    api = await bootTestApi();
    const org = await defaultAssistantSessionFor(api.providers, 
      { type: "org", id: "org-a" },
      { actorUserId: "local-user", orgId: "local-org" },
    );
    const user = await defaultAssistantSessionFor(api.providers, 
      { type: "user", id: "local-user" },
      { actorUserId: "local-user", orgId: "local-org" },
    );

    const receipt = await admitSignal(deps(api), {
      from: { sessionId: org.id, owner: { type: "org", id: "org-a" } },
      to: user.id,
      threadKey: `signal:${org.id}`,
      content: { kind: "signal", signalType: "orchestrator.message", body: "org says hi" },
      dispatchId: "d-org-to-user",
    });
    expect(receipt.status).toBeDefined();
  });

  it("user -> user orchestrator (same org) is denied and drop-logged", async () => {
    api = await bootTestApi();
    const user1 = await defaultAssistantSessionFor(api.providers, 
      { type: "user", id: "local-user" },
      { actorUserId: "local-user", orgId: "local-org" },
    );
    const user2 = await defaultAssistantSessionFor(api.providers, 
      { type: "user", id: "user-2" },
      { actorUserId: "user-2", orgId: "local-org" },
    );

    await expect(
      admitSignal(deps(api), {
        from: { sessionId: user1.id, owner: { type: "user", id: "local-user" } },
        to: user2.id,
        threadKey: `signal:${user1.id}`,
        content: { kind: "signal", signalType: "orchestrator.message", body: "hey" },
        dispatchId: "d-user-to-user",
      }),
    ).rejects.toThrow(SignalEdgeDeniedError);

    const rows = await api.providers.db
      .select()
      .from(eventDropLog)
      .where(eq(eventDropLog.conversationKey, "d-user-to-user"))
      ;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe("edge_denied");
  });

  it("cross-org orchestrator signal is denied and drop-logged", async () => {
    api = await bootTestApi();
    const orgA = await defaultAssistantSessionFor(api.providers, 
      { type: "org", id: "org-a" },
      { actorUserId: "local-user", orgId: "local-org" },
    );
    const orgB = await defaultAssistantSessionFor(api.providers, 
      { type: "user", id: "user-3" },
      { actorUserId: "user-3", orgId: "other-org" },
    );

    await expect(
      admitSignal(deps(api), {
        from: { sessionId: orgA.id, owner: { type: "org", id: "org-a" } },
        to: orgB.id,
        threadKey: `signal:${orgA.id}`,
        content: { kind: "signal", signalType: "orchestrator.message", body: "cross org" },
        dispatchId: "d-cross-org",
      }),
    ).rejects.toThrow(SignalEdgeDeniedError);

    const rows = await api.providers.db
      .select()
      .from(eventDropLog)
      .where(eq(eventDropLog.conversationKey, "d-cross-org"))
      ;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe("edge_denied");
  });

  it("a dead engine thread id does not get-or-create a phantom thread; denied and drop-logged", async () => {
    api = await bootTestApi();
    const parent = await api.providers.engineHost.sessionFor("parent-3", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const parentThread = parent.thread("web:default");
    await api.providers.engineHost.childSessionFor("child-3", {
      parentSessionId: "parent-3",
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      orgId: "local-org",
      owner: { type: "user", id: "local-user" },
      workspace: "/tmp",
    });

    // Shaped like an engine thread id (th-<ts36>-<counter36>) but never
    // minted on the parent session — threadById returns null for it. Before
    // the fix, resolveThread's `?? session.thread(threadKey)` fallback would
    // get-or-create a new thread KEYED by this id string and the signal
    // would land there invisibly instead of being denied.
    const deadThreadId = "th-0-nonexistent";

    await expect(
      admitSignal(deps(api), {
        from: { sessionId: "child-3", owner: { type: "user", id: "local-user" } },
        to: "parent-3",
        threadKey: deadThreadId,
        content: { kind: "signal", signalType: "child.settled", body: "done" },
        dispatchId: "d-dead-thread",
      }),
    ).rejects.toThrow(SignalEdgeDeniedError);

    expect(parent.threadById(deadThreadId)).toBeNull();

    const rows = await api.providers.db
      .select()
      .from(eventDropLog)
      .where(eq(eventDropLog.conversationKey, "d-dead-thread"))
      ;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe("edge_denied");
    expect(rows[0]?.detail).toContain(deadThreadId);
  });

  it("unrelated sessions (no parent/child, no orchestrator edge) are denied", async () => {
    api = await bootTestApi();
    await api.providers.engineHost.sessionFor("solo-a", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    await api.providers.engineHost.sessionFor("solo-b", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });

    await expect(
      admitSignal(deps(api), {
        from: { sessionId: "solo-a", owner: { type: "user", id: "local-user" } },
        to: "solo-b",
        threadKey: "web:default",
        content: { kind: "signal", signalType: "orchestrator.message", body: "nope" },
        dispatchId: "d-unrelated",
      }),
    ).rejects.toThrow(SignalEdgeDeniedError);
  });

  // A signal is the one path that rebuilds a session nobody is looking at, so
  // it decides that session's 1Password scopes for the rest of its life. The
  // generic builder hands the engine no owner, so `SessionData.owner` says
  // "user" even for a team-owned session; taking ownership from there would
  // grant the frozen actor's personal scope on a session the whole team can
  // prompt. The app row is the truth.
  it("a team-owned session rebuilt by a signal reads on the org scope alone", async () => {
    const scopesTried: string[] = [];
    const unused = (): never => {
      throw new Error("not exercised by this suite");
    };
    const onePassword: OnePasswordService = {
      tokenConnected: unused,
      listVaults: unused,
      resolveReference: unused,
      resolveCredential: async (row) => row,
      findCredentialForService: async (scope) => {
        scopesTried.push(scope);
        return null;
      },
    };
    api = await bootTestApi({ onePassword });

    // Built the way `POST /api/sessions` builds one: no owner reaches the
    // engine, so its principal defaults to the acting user.
    const parent = await api.providers.engineHost.sessionFor("parent-team-1", {
      userId: "user-a",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const parentThread = parent.thread("web:default");
    await api.providers.engineHost.childSessionFor("child-team-1", {
      parentSessionId: "parent-team-1",
      parentThreadId: parentThread.id,
      actorUserId: "user-a",
      orgId: "local-org",
      owner: { type: "team", id: "team-1" },
      workspace: "/tmp",
    });
    // The app row is team-owned, which is what the routes read.
    await api.providers.db.insert(agentSessions).values({
      id: "parent-team-1",
      userId: "user-a",
      orgId: "local-org",
      workspace: "/workspace",
      ownerType: "team",
      ownerId: "team-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // The parent is idle and falls out of cache (an api restart does this).
    api.providers.engineHost.evictCache("parent-team-1");
    await admitSignal(deps(api), {
      from: { sessionId: "child-team-1", owner: { type: "team", id: "team-1" } },
      to: "parent-team-1",
      threadKey: parentThread.id,
      content: { kind: "signal", signalType: "child.settled", body: "done" },
      dispatchId: "d-team-rebuild",
    });

    // The session the signal rebuilt is the cached one from here on.
    const rebuilt = await api.providers.engineHost.sessionFor("parent-team-1", {
      userId: "user-a",
      orgId: "local-org",
      workspace: "/tmp",
    });
    await rebuilt.credentialProvider().get("linear");
    expect(scopesTried).toEqual(["org"]);
  });
});
