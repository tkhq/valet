/**
 * Integration test (key-gated): the full Task 8 wiring — a real orchestrator
 * turn calls the engine's `task` built-in, which reaches the injected
 * ChildSpawner (bootTestApi wires the same spawner/watcher pair main.ts
 * does), spawns a virtual-sandbox child session that runs a real model turn,
 * and the ChildWatcher reports the settlement back to the SPAWNING parent
 * thread as a `child.settled` signal entry.
 *
 * The ungated unit path for the watcher (double-arm dedupe, hand-settled
 * submission) lives in src/orchestrator/children.test.ts — this suite only
 * proves the live wiring.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "./_setup.js";
import { driveTurn } from "./_test-utils.js";
import { childWatches } from "../schema/index.js";
import type { EnsureOrchestratorResponse } from "../wire/types.js";

const describeIfKey = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
}, 30_000);

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("waitFor: timed out");
}

describeIfKey("api integration: orchestrator spawns a child via task, receives child.settled", () => {
  it(
    "task tool -> child session -> watcher -> child.settled signal on the spawning thread",
    async () => {
      api = await bootTestApi();

      const ensureRes = await fetch(`${api.baseUrl}/api/orchestrator`, { method: "POST" });
      expect(ensureRes.status).toBe(200);
      const { sessionId } = (await ensureRes.json()) as EnsureOrchestratorResponse;

      await driveTurn({
        baseUrl: api.baseUrl,
        wsUrl: api.wsUrl,
        sessionId,
        prompt:
          "Use the task tool exactly once to spawn a child session with the prompt " +
          "\"Reply with exactly the word 'done' and nothing else. Do not use any tools.\" " +
          "and the title \"itest-child\". After the tool returns, reply 'spawned' and stop. " +
          "Do not use any other tools.",
        timeoutMs: 90_000,
      });

      // The spawner inserted a watch row before task returned.
      const rows = await api.providers.db.select().from(childWatches).all();
      expect(rows).toHaveLength(1);
      const watch = rows[0];
      expect(watch.parentSessionId).toBe(sessionId);

      // The child runs its own real model turn, settles, and the watcher
      // marks the watch settled after admitting the signal to the parent.
      await waitFor(async () => {
        const row = await api!.providers.db
          .select()
          .from(childWatches)
          .where(eq(childWatches.childSessionId, watch.childSessionId))
          .get();
        return row?.settled === 1;
      }, 90_000);

      // The child session got no spawner (depth limit).
      const child = api.providers.engineHost.liveSession(watch.childSessionId);
      expect(child).not.toBeNull();
      expect(child?.options.toolConfig?.childSpawner).toBeUndefined();
      expect(child?.options.purpose).toBe("child");

      // The signal entry lands on the SPAWNING parent thread once the
      // orchestrator claims the signal turn.
      const parent = api.providers.engineHost.liveSession(sessionId);
      expect(parent).not.toBeNull();
      await waitFor(async () => {
        const entries = (await parent!.readEntries("web:default")) ?? [];
        return entries.some(
          (e) =>
            e.type === "message" &&
            e.signal?.signalType === "child.settled" &&
            e.signal.attributes?.child_session_id === watch.childSessionId &&
            e.signal.senderSessionId === watch.childSessionId,
        );
      }, 90_000);
    },
    240_000,
  );
});
