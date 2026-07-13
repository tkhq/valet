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
import { eventDropLog } from "../schema/index.js";

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
    const org = await api.providers.engineHost.orchestratorSessionFor(
      { type: "org", id: "org-a" },
      { actorUserId: "local-user", orgId: "local-org" },
    );
    const user = await api.providers.engineHost.orchestratorSessionFor(
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
    const user1 = await api.providers.engineHost.orchestratorSessionFor(
      { type: "user", id: "local-user" },
      { actorUserId: "local-user", orgId: "local-org" },
    );
    const user2 = await api.providers.engineHost.orchestratorSessionFor(
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
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe("edge_denied");
  });

  it("cross-org orchestrator signal is denied and drop-logged", async () => {
    api = await bootTestApi();
    const orgA = await api.providers.engineHost.orchestratorSessionFor(
      { type: "org", id: "org-a" },
      { actorUserId: "local-user", orgId: "local-org" },
    );
    const orgB = await api.providers.engineHost.orchestratorSessionFor(
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
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe("edge_denied");
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
});
