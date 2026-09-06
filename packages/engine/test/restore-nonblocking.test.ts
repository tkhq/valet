import { describe, it, expect } from "vitest";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, Type } from "@earendil-works/pi-ai/compat";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type ToolDef,
} from "../src/index.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function poll(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(25);
  }
}

/**
 * Regression proof for the restore deadlock (dev incident 2026-09-05,
 * session child_a3eb6e52): `Session.rehydrate` awaits `reconcile()`, and the
 * reconcile "resume" branch used to await the ENTIRE resumed turn
 * (`driveResumeToCompletion`). A resumed turn that parks — on a decision
 * gate awaiting a human, or a long tool call — therefore held
 * `restoreSession` (and through the host's single-flight map, every
 * threads/messages/decisions route) pending until the turn settled. A turn
 * parked on a human gate never settles on its own, so the session's whole
 * API surface deadlocked: the human could not see the gate that was waiting
 * for them.
 *
 * The contract under test: `restoreSession` resolves once reconciliation
 * has re-claimed unsettled work and KICKED the resume drive — it must not
 * wait for the resumed turn to finish. The drive still runs to completion
 * in the background (asserted via awaitResult after the tool is released).
 */
describe("restoreSession does not block on the resumed turn", () => {
  it("resolves while the resumed turn is still mid-tool, then the turn settles in the background", async () => {
    const faux = registerFauxProvider({ provider: "restore-nonblocking" });
    faux.setResponses([
      // Turn (pre-"crash"): the model calls hang_a, which never returns —
      // this is the state an api restart interrupts.
      fauxAssistantMessage([fauxToolCall("hang_a", {}, { id: "call-1" })], {
        stopReason: "toolUse",
      }),
      // Resumed turn's continuation (post-restore): the model calls hang_b,
      // which blocks until the test releases it — the stand-in for a turn
      // that parks on a decision gate or a slow tool after resume.
      fauxAssistantMessage([fauxToolCall("hang_b", {}, { id: "call-2" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done after restart"),
    ]);

    const hangA = deferred();
    const hangB = deferred();
    let aStarted = false;

    const toolHangA: ToolDef<ReturnType<typeof Type.Object>> = {
      name: "hang_a",
      description: "blocks until released — the interrupted call",
      parameters: Type.Object({}),
      execute: async () => {
        aStarted = true;
        await hangA.promise;
        return { text: "a done" };
      },
    };
    const toolHangB: ToolDef<ReturnType<typeof Type.Object>> = {
      name: "hang_b",
      description: "blocks until released — the resumed turn's parked call",
      parameters: Type.Object({}),
      execute: async () => {
        await hangB.promise;
        return { text: "b done" };
      },
    };

    // One shared store = the durable state a restarted process would read.
    const store = new InMemorySessionStore();

    try {
      // ── Phase 1: run a turn up to the point where hang_a is mid-execution.
      // The assistant entry with the running tool_call is persisted before the
      // tool executes, so the store now holds exactly the mid-turn state an
      // api crash leaves behind. engine1's drive is a zombie from here on —
      // reconciliation's fresh attempt fences its late writes out.
      const engine1 = new Engine({
        providers: {
          store,
          stream: new InMemoryEventStream(),
          sandboxProvider: new VirtualSandboxProvider(),
        },
      });
      const session1 = await engine1.createSession({
        id: "restore-nonblocking-sess",
        userId: "u1",
        orgId: "o1",
        workspace: "/",
        sandbox: {},
        model: faux.getModel(),
        tools: [toolHangA, toolHangB],
      });
      const receipt = await session1.prompt("go");
      await poll(() => aStarted, 10_000, "hang_a to start executing");
      // Settle window so the entry write is unambiguously committed.
      await sleep(250);

      // ── Phase 2: a fresh Engine restores over the same store. The resumed
      // turn's continuation immediately parks in hang_b, so under the old
      // (awaited-drive) behavior this restoreSession never resolves.
      const engine2 = new Engine({
        providers: {
          store,
          stream: new InMemoryEventStream(),
          sandboxProvider: new VirtualSandboxProvider(),
        },
      });
      const restorePromise = engine2.restoreSession({
        sessionId: "restore-nonblocking-sess",
        options: {
          userId: "u1",
          orgId: "o1",
          workspace: "/",
          sandbox: {},
          model: faux.getModel(),
          tools: [toolHangA, toolHangB],
        },
      });

      const winner = await Promise.race([
        restorePromise.then(() => "restored" as const),
        sleep(10_000).then(() => "still pending after 10s" as const),
      ]);
      expect(winner).toBe("restored");

      // The resumed turn is still parked in hang_b right now — the item must
      // not be settled yet (restore resolved BEFORE the turn finished, not
      // because the turn happened to be fast).
      const midItem = await store.getQueueItem("restore-nonblocking-sess", receipt.queueItemId);
      expect(midItem?.status).not.toBe("settled");

      // Release the parked tool: the background drive completes the turn.
      hangB.resolve();
      const session2 = await restorePromise;
      const result = await session2.thread().awaitResult(receipt.queueItemId);
      expect(result).toMatchObject({
        queueItemId: receipt.queueItemId,
        outcome: "completed",
        text: "done after restart",
      });

      const item = await store.getQueueItem("restore-nonblocking-sess", receipt.queueItemId);
      expect(item?.status).toBe("settled");

      // Pin the RESUME branch (not the release-and-rerun branch, which would
      // also satisfy every assertion above): the resume path replaces the
      // attempt (1 → 2) and repairs the dangling call-1 to an error part
      // carrying the restart marker. Release-and-rerun would re-execute from
      // scratch with no repaired part.
      expect(item?.attemptCount).toBe(2);
      const entries = await store.getEntries("restore-nonblocking-sess", session2.thread().id);
      const parts = entries
        .filter((e) => e.type === "message" && e.role === "assistant")
        .flatMap((e) => (e.type === "message" ? (e.parts ?? []) : []));
      const call1 = parts.find((p) => p.type === "tool_call" && p.callId === "call-1");
      expect(call1 && call1.type === "tool_call" ? call1.status : undefined).toBe("error");
      expect(call1 && call1.type === "tool_call" ? call1.error : undefined).toContain(
        "result lost in restart",
      );
    } finally {
      // Unpark the zombie and the resumed drive so nothing leaks past the test.
      hangA.resolve();
      hangB.resolve();
      faux.unregister();
    }
  }, 30_000);

  it("a second same-process restore does not steal the live resume drive's attempt", async () => {
    // Cache-evict-then-rebuild scenario (host.evictCache + sessionFor): a
    // SECOND Engine restores the same session while the first restore's
    // background drive is still mid-turn in the same process. Startup
    // reconciliation's eager takeover exists because "the previous owner is
    // gone by contract" — false here, the owner is this process. The second
    // reconcile must WAIT, not CAS-steal the live attempt and run the same
    // turn's tools a second time.
    const faux = registerFauxProvider({ provider: "restore-no-steal" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("hang_a", {}, { id: "call-1" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxToolCall("hang_b", {}, { id: "call-2" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done once"),
    ]);

    const hangA = deferred();
    const hangB = deferred();
    let aStarted = false;
    let bStarted = false;

    const toolHangA: ToolDef<ReturnType<typeof Type.Object>> = {
      name: "hang_a",
      description: "blocks until released",
      parameters: Type.Object({}),
      execute: async () => {
        aStarted = true;
        await hangA.promise;
        return { text: "a done" };
      },
    };
    const toolHangB: ToolDef<ReturnType<typeof Type.Object>> = {
      name: "hang_b",
      description: "blocks until released",
      parameters: Type.Object({}),
      execute: async () => {
        bStarted = true;
        await hangB.promise;
        return { text: "b done" };
      },
    };

    const store = new InMemorySessionStore();
    const sessionOpts = {
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools: [toolHangA, toolHangB],
    };

    try {
      const engine1 = new Engine({
        providers: {
          store,
          stream: new InMemoryEventStream(),
          sandboxProvider: new VirtualSandboxProvider(),
        },
      });
      const session1 = await engine1.createSession({ id: "no-steal-sess", ...sessionOpts });
      const receipt = await session1.prompt("go");
      await poll(() => aStarted, 10_000, "hang_a to start executing");
      await sleep(250);

      // Restore #1: claims attempt 2, kicks the drive; the drive parks in
      // hang_b (the resumed turn's continuation).
      const engine2 = new Engine({
        providers: {
          store,
          stream: new InMemoryEventStream(),
          sandboxProvider: new VirtualSandboxProvider(),
        },
      });
      const session2 = await engine2.restoreSession({
        sessionId: "no-steal-sess",
        options: { ...sessionOpts },
      });
      await poll(() => bStarted, 10_000, "resume drive to park in hang_b");

      // Restore #2 (the rebuild): must resolve without stealing the live
      // attempt. A steal shows durably as attemptCount 3 and, with the shared
      // faux queue, as an early settlement off the next scripted response.
      const engine3 = new Engine({
        providers: {
          store,
          stream: new InMemoryEventStream(),
          sandboxProvider: new VirtualSandboxProvider(),
        },
      });
      await engine3.restoreSession({
        sessionId: "no-steal-sess",
        options: { ...sessionOpts },
      });
      await sleep(250);

      const mid = await store.getQueueItem("no-steal-sess", receipt.queueItemId);
      expect(mid?.status).toBe("running");
      expect(mid?.attemptCount).toBe(2);

      // The live drive (restore #1's) still owns the turn: release it and it
      // settles normally, exactly once.
      hangB.resolve();
      const result = await session2.thread().awaitResult(receipt.queueItemId);
      expect(result).toMatchObject({ outcome: "completed", text: "done once" });
      const settled = await store.getQueueItem("no-steal-sess", receipt.queueItemId);
      expect(settled?.attemptCount).toBe(2);
    } finally {
      hangA.resolve();
      hangB.resolve();
      faux.unregister();
    }
  }, 30_000);

  it("abort()/destroy() join the background resume drive before tearing down", async () => {
    // DELETE /api/sessions/:id flows through Session.destroy -> thread.abort.
    // The abort must be able to JOIN the fire-and-forget resume drive (the
    // same way it joins kickTail for normal turns) so teardown never deletes
    // rows and sandbox under a still-writing turn.
    const faux = registerFauxProvider({ provider: "restore-join" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("hang_a", {}, { id: "call-1" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxToolCall("hang_b", {}, { id: "call-2" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("never reached"),
    ]);

    const hangA = deferred();
    const hangB = deferred();
    let aStarted = false;
    let bStarted = false;
    let bFinished = false;

    const toolHangA: ToolDef<ReturnType<typeof Type.Object>> = {
      name: "hang_a",
      description: "blocks until released",
      parameters: Type.Object({}),
      execute: async () => {
        aStarted = true;
        await hangA.promise;
        return { text: "a done" };
      },
    };
    const toolHangB: ToolDef<ReturnType<typeof Type.Object>> = {
      name: "hang_b",
      description: "blocks until released",
      parameters: Type.Object({}),
      execute: async () => {
        bStarted = true;
        await hangB.promise;
        bFinished = true;
        return { text: "b done" };
      },
    };

    const store = new InMemorySessionStore();
    const sessionOpts = {
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools: [toolHangA, toolHangB],
    };

    try {
      const engine1 = new Engine({
        providers: {
          store,
          stream: new InMemoryEventStream(),
          sandboxProvider: new VirtualSandboxProvider(),
        },
      });
      const session1 = await engine1.createSession({ id: "join-sess", ...sessionOpts });
      const receipt = await session1.prompt("go");
      await poll(() => aStarted, 10_000, "hang_a to start executing");
      await sleep(250);

      const engine2 = new Engine({
        providers: {
          store,
          stream: new InMemoryEventStream(),
          sandboxProvider: new VirtualSandboxProvider(),
        },
      });
      const session2 = await engine2.restoreSession({
        sessionId: "join-sess",
        options: { ...sessionOpts },
      });
      await poll(() => bStarted, 10_000, "resume drive to park in hang_b");

      // Abort while the drive is parked mid-tool. Release the tool shortly
      // after: abort must not resolve until the drive has fully unwound and
      // settled the item.
      const abortDone = session2.abort();
      await sleep(100);
      hangB.resolve();
      await abortDone;

      expect(bFinished).toBe(true);
      const item = await store.getQueueItem("join-sess", receipt.queueItemId);
      expect(item?.status).toBe("settled");
      expect(item?.outcome).toEqual({ outcome: "aborted" });
    } finally {
      hangA.resolve();
      hangB.resolve();
      faux.unregister();
    }
  }, 30_000);
});
