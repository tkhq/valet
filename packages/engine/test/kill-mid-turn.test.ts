import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  fauxAssistantMessage,
  registerFauxProvider,
  Type,
} from "@earendil-works/pi-ai/compat";
import { PgSessionStore, pgDbFromPglite } from "@valet/store-postgres";
import {
  Engine,
  InMemoryEventStream,
  VirtualSandboxProvider,
  type MessageEntry,
  type ToolDef,
} from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = join(__dirname, "..");
const CHILD = join(__dirname, "kill-child.ts");

/** Poll a predicate until true or the deadline; throws on timeout. */
async function poll(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Count `executed:` lines in the marker file (0 if it does not exist yet). */
async function countExecuted(markerPath: string): Promise<number> {
  try {
    const text = await readFile(markerPath, "utf8");
    return text.split("\n").filter((l) => l.startsWith("executed:")).length;
  } catch {
    return 0;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("kill-mid-turn recovery (cross-process SIGKILL, exit criterion)", () => {
  it(
    "SIGKILL mid-tool → restart repairs the dangling tool_call to error, completes, no duplicate side effect",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "valet-kill-mid-turn-"));
      // PGlite wants a directory to persist to, not a single file — unlike the
      // sqlite predecessor's single `engine.db` path.
      const dataDir = join(dir, "pgdata");
      const markerPath = join(dir, "marker.log");

      // ── Phase 1: run the turn in a child process, then SIGKILL it mid-tool ──
      const child: ChildProcess = spawn(
        process.execPath,
        ["--import", "tsx", CHILD, dataDir, markerPath],
        { cwd: ENGINE_ROOT, stdio: ["ignore", "pipe", "pipe"] },
      );

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (b: Buffer) => {
        stdout += b.toString();
      });
      child.stderr?.on("data", (b: Buffer) => {
        stderr += b.toString();
      });

      const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));

      try {
        // Wait for the child to admit + start the turn (READY) and for the tool
        // to record its first side effect (marker line) — that's the point where
        // the assistant entry with a running tool_call is durably persisted and
        // the tool is now sleeping.
        await poll(() => /READY:\S+/.test(stdout), 25_000, `READY (stderr: ${stderr})`);
        await poll(() => countExecuted(markerPath).then((n) => n >= 1), 25_000, "first executed line");

        const queueItemId = stdout.match(/READY:(\S+)/)?.[1];
        expect(queueItemId).toBeTruthy();
        if (!queueItemId) throw new Error("no queueItemId");

        // Small settle window so the synchronous entry write is unambiguously
        // committed before we yank the process.
        await new Promise((r) => setTimeout(r, 250));

        // Exactly one side effect happened before the kill.
        expect(await countExecuted(markerPath)).toBe(1);

        child.kill("SIGKILL");
        await exited;

        // ── Phase 2: fresh Engine over the same db → reconciliation on restore ──
        const faux = registerFauxProvider({ provider: "kill-mid-turn" });
        // Continuation after the repaired interrupted-tool error: conclude the
        // turn. The model does NOT re-issue call-1 or emit call-2.
        faux.setResponses([fauxAssistantMessage("all done after restart")]);

        let reexecuted = 0;
        const slowMarker: ToolDef<ReturnType<typeof Type.Object>> = {
          name: "slow_marker",
          description: "re-execution tripwire",
          parameters: Type.Object({ tag: Type.String() }),
          execute: async (args) => {
            reexecuted += 1;
            const tag = (args as { tag: string }).tag;
            // If reconciliation wrongly re-runs the interrupted call, this fires
            // and the marker-count assertion below catches it (no sleep, so the
            // test fails fast rather than hanging).
            const { appendFile } = await import("node:fs/promises");
            await appendFile(markerPath, `executed:${tag}\n`);
            return { text: `re-run ${tag}` };
          },
        };

        const pglite = await PGlite.create(dataDir);
        const store = new PgSessionStore(pgDbFromPglite(pglite));
        const bus = new InMemoryEventStream();
        const engine = new Engine({
          providers: { store, stream: bus, sandboxProvider: new VirtualSandboxProvider() },
        });

        const session = await engine.restoreSession({
          sessionId: "kill-sess",
          options: {
            userId: "u1",
            orgId: "o1",
            workspace: "/",
            sandbox: {},
            model: faux.getModel(),
            tools: [slowMarker],
          },
        });

        // restoreSession awaits reconciliation, which drives the resume to
        // completion — the item is settled by the time awaitResult reads it.
        const result = await session.thread().awaitResult(queueItemId);

        expect(result).toEqual({
          queueItemId,
          outcome: "completed",
          text: "all done after restart",
        });

        // No duplicate side effect: the interrupted call was repaired to an
        // error, never re-run; the second scripted call never started.
        expect(reexecuted).toBe(0);
        expect(await countExecuted(markerPath)).toBe(1);

        // The item settled `completed`, and reconciliation's fresh attempt makes
        // the child's claim (attempt 1) into attempt 2.
        const item = await store.getQueueItem("kill-sess", queueItemId);
        expect(item?.status).toBe("settled");
        expect(item?.outcome).toEqual({ outcome: "completed" });
        expect(item?.attemptCount).toBe(2);

        // The dangling tool_call part reads status "error" with the restart note.
        const entries = await store.getEntries("kill-sess", session.thread().id);
        const parts = entries
          .filter((e): e is MessageEntry => e.type === "message" && e.role === "assistant")
          .flatMap((e) => e.parts ?? []);
        const call1 = parts.find((p) => p.type === "tool_call" && p.callId === "call-1");
        expect(call1 && call1.type === "tool_call" ? call1.status : undefined).toBe("error");
        expect(call1 && call1.type === "tool_call" ? call1.error : undefined).toContain(
          "result lost in restart",
        );
        // call-2 was never emitted by the model, so no such part exists.
        expect(parts.some((p) => p.type === "tool_call" && p.callId === "call-2")).toBe(false);

        await pglite.close();
        faux.unregister();
        await expect(fileExists(dataDir)).resolves.toBe(true);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    },
    45_000,
  );
});
