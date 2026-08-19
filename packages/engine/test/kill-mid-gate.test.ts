import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  fauxAssistantMessage,
  registerFauxProvider,
  Type,
} from "@earendil-works/pi-ai/compat";
import { PgSessionStore, PgEventStream, pgDbFromPglite } from "@valet/store-postgres";
import {
  Engine,
  VirtualSandboxProvider,
  type StoredBusEvent,
  type ToolDef,
} from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = join(__dirname, "..");
const CHILD = join(__dirname, "kill-gate-child.ts");
const SESSION_ID = "kill-gate-sess";

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

const approvalParams = Type.Object({ arg: Type.String() });
const approvalTool: ToolDef<typeof approvalParams> = {
  name: "do_thing",
  description: "approval-gated",
  parameters: approvalParams,
  execute: async (args, ctx) => {
    const r = await ctx.requestDecision({
      type: "approval",
      title: "ok?",
      resumeKey: "kg",
    });
    return { text: `did with ${r.actionId}` };
  },
};

describe("kill-mid-gate recovery (cross-process SIGKILL, roadmap exit criterion)", () => {
  it(
    "SIGKILL while a gate is pending → restart re-arms, resolve replays the turn to completion, durable log holds one pending + one resolved event",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "valet-kill-mid-gate-"));
      // PGlite wants a directory to persist to, not a single file — unlike the
      // sqlite predecessor's single `engine.db` path.
      const dataDir = join(dir, "pgdata");

      // ── Phase 1: run the turn in a child, then SIGKILL it while the gate is pending ──
      const child: ChildProcess = spawn(
        process.execPath,
        ["--import", "tsx", CHILD, dataDir],
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
        await poll(() => /READY:\S+/.test(stdout), 25_000, `READY (stderr: ${stderr})`);
        const gateId = stdout.match(/READY:(\S+)/)?.[1];
        expect(gateId).toBeTruthy();
        if (!gateId) throw new Error("no gateId");
        // First gate for this (queueItem, resumeKey) is ordinal 0 — same gate,
        // not a twin, must survive the restart.
        expect(gateId.endsWith(":0")).toBe(true);

        // Small settle window so the durable gate + blocked writes are
        // unambiguously committed before we yank the process.
        await new Promise((r) => setTimeout(r, 250));

        child.kill("SIGKILL");
        await exited;

        // ── Phase 2: fresh Engine over the same db → reconciliation re-arms the gate ──
        const faux = registerFauxProvider({ provider: "kill-mid-gate" });
        // Continuation after the gate resolves: the replayed tool returns, then
        // the model concludes the turn.
        faux.setResponses([fauxAssistantMessage("all done after restart")]);

        const pglite = await PGlite.create(dataDir);
        const pgdb = pgDbFromPglite(pglite);
        const store = new PgSessionStore(pgdb);
        const stream = new PgEventStream(pgdb);
        const engine = new Engine({
          providers: { store, stream, sandboxProvider: new VirtualSandboxProvider() },
        });

        const session = await engine.restoreSession({
          sessionId: SESSION_ID,
          options: {
            userId: "u1",
            orgId: "o1",
            workspace: "/",
            sandbox: {},
            model: faux.getModel(),
            tools: [approvalTool],
          },
        });

        // The re-armed gate is pending again after reconciliation.
        const rearmed = await store.getDecisionGate(SESSION_ID, gateId);
        expect(rearmed?.status).toBe("pending");

        // Find the blocked submission so we can await its result.
        const gate = await store.getDecisionGate(SESSION_ID, gateId);
        expect(gate).toBeTruthy();
        const itemId = gate?.queueItemId;
        expect(itemId).toBeTruthy();
        if (!itemId) throw new Error("no queueItemId on gate");

        // Resolve the gate from the "UI" — the suspended turn replays.
        await session.resolveDecision(gateId, {
          actionId: "approve",
          resolvedBy: "u1",
          resolvedAt: Date.now(),
        });

        const result = await session.thread().awaitResult(itemId);
        expect(result).toEqual({
          queueItemId: itemId,
          outcome: "completed",
          text: "all done after restart",
        });

        // The gate is durably resolved — and it's still the SAME gate (ordinal 0,
        // no twin minted on restore).
        const finalGate = await store.getDecisionGate(SESSION_ID, gateId);
        expect(finalGate?.status).toBe("resolved");
        const allGates = await store.listDecisionGates(SESSION_ID);
        expect(allGates).toHaveLength(1);
        expect(allGates[0]?.id).toBe(gateId);
        expect(allGates[0]?.id.endsWith(":0")).toBe(true);

        // The submission settled completed.
        const item = await store.getQueueItem(SESSION_ID, itemId);
        expect(item?.status).toBe("settled");
        expect(item?.outcome).toEqual({ outcome: "completed" });

        // ── Durable event log: exactly one pending + one resolved for this gate,
        //    appended once across the restart; offsets dense/gap-free. ──
        const { events } = await stream.read(SESSION_ID);
        const gateEvents = events.filter(
          (e: StoredBusEvent): boolean =>
            e.event.type === "decision_gate" && e.event.gate.id === gateId,
        );
        expect(gateEvents).toHaveLength(1);
        const resolvedEvents = events.filter(
          (e: StoredBusEvent): boolean =>
            e.event.type === "decision_gate_resolved" && e.event.gateId === gateId,
        );
        expect(resolvedEvents).toHaveLength(1);

        // Offsets are a dense, gap-free 1..N sequence (no holes across restart).
        const seqs = events.map((e) => Number(e.offset));
        expect(seqs.length).toBeGreaterThan(0);
        expect(seqs).toEqual(seqs.map((_, i) => i + 1));

        await pglite.close();
        faux.unregister();
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    },
    45_000,
  );
});
