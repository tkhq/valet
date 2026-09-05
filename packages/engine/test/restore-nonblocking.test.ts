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
        sleep(3_000).then(() => "still pending after 3s" as const),
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
    } finally {
      // Unpark the zombie and the resumed drive so nothing leaks past the test.
      hangA.resolve();
      hangB.resolve();
      faux.unregister();
    }
  }, 30_000);
});
