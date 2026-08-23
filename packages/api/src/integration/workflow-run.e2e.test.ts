/**
 * Phase 5 exit-criteria E2E (plan Task 12): a real workflow — trigger ->
 * session(start, schema-validated output) -> approval(onDeny 'fail') ->
 * wait 2s -> stop — killed and restarted at three points, with duplicate-
 * dispatch assertions. Real Anthropic + Docker; this is the phase gate.
 *
 * Structure mirrors `orchestrator-restart.test.ts`, but spawns the actual
 * HTTP server entrypoint (`src/main.ts`) as a child process (not an
 * in-process helper harness) so a `SIGKILL` genuinely tears down the
 * process the way a crash would, and drives it entirely over HTTP — the
 * `WF_CRASH_AT=terminalizing` hook (plan decision 20) only reads from
 * `process.env` at `main.ts` boot, so this is the only way to exercise it.
 *
 * Three restart points (plan Task 12 / brief):
 *   (a) mid-node    — SIGKILL right after the run parks on the session's
 *                      submission wait (dispatch landed, turn not settled).
 *   (b) parked-on-approval — SIGKILL while parked on the approval signal
 *                      wait, restart, resolve the approval over HTTP.
 *   (c) terminalizing — a SECOND run of the same definition, driven against
 *                      a process booted with `WF_CRASH_AT=terminalizing`;
 *                      the host `process.exit(137)`s right after
 *                      `beginTerminalize`. Restart without the env var and
 *                      let the poll loop's expired-lease reclaim (up to
 *                      leaseMs=30s) finish the two-phase settle.
 *
 * Final assertions (decision 21): each `workflow:{runId}:{nodeId}[:repair]`
 * dispatchId maps to exactly one `engine_queue_items` row (queried directly
 * against the engine's pg tables — the schema's own partial unique index
 * on `(session_id, dispatch_id)` is what *guarantees* this, but the
 * assertion is the exit criterion's explicit ask); each `(runId, nodeId,
 * iteration)` has exactly one `workflow_checkpoints` row; the session
 * node's checkpoint result carries a schema-valid `{ answer: string }`
 * output; both runs settle `completed`.
 *
 * Key-gated: skipped without `ANTHROPIC_API_KEY`. Requires a running Docker
 * daemon (the session node provisions a real `DockerSandboxProvider`
 * container per session) — not separately gated, matching this repo's other
 * Docker-dependent integration tests (e.g. `scripts/smoke-session.ts`).
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type {
  CreateWorkflowResponse,
  GetWorkflowRunResponse,
  StartWorkflowRunResponse,
} from "../wire/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_ROOT = join(__dirname, "..", "..");
const MAIN = join(API_ROOT, "src", "main.ts");

const describeIfKey = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;

const MODEL = "claude-haiku-4-5";

/** Poll a predicate until true or the deadline; throws (with the last seen
 * value, when a `describe` function is given) on timeout. */
async function poll<T>(
  fn: () => Promise<T>,
  ok: (v: T) => boolean,
  timeoutMs: number,
  label: string,
  intervalMs = 750,
): Promise<T> {
  const start = Date.now();
  let last: T | undefined;
  for (;;) {
    last = await fn();
    if (ok(last)) return last;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${label}; last value: ${JSON.stringify(last)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

interface ApiProcess {
  child: ChildProcess;
  baseUrl: string;
  stdout(): string;
  stderr(): string;
  /** Resolves with (code, signal) on exit — awaited by callers driving the crash paths. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Spawn `src/main.ts` as a real child process (tsx), pointed at the given
 * on-disk db/blobs paths, and wait for it to report "listening". */
async function spawnApi(opts: {
  port: number;
  pgDataDir: string;
  blobsRoot: string;
  crashAt?: "terminalizing";
}): Promise<ApiProcess> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(opts.port),
    VALET_PG_DATA_DIR: opts.pgDataDir,
    VALET_BLOBS_DIR: opts.blobsRoot,
    VALET_ENCRYPTION_KEY: "test-key",
    VALET_LOCAL_AUTH: "1",
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  if (opts.crashAt) env.WF_CRASH_AT = opts.crashAt;
  else delete env.WF_CRASH_AT;
  // This api runs on STUB auth. An ambient BETTER_AUTH_SECRET in the runner's
  // shell would pair real auth with the stub above, which `startServer`
  // refuses to boot (see auth/config.ts's authModeConflict).
  delete env.BETTER_AUTH_SECRET;

  const child = spawn(process.execPath, ["--import", "tsx", MAIN], {
    cwd: API_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (b: Buffer) => {
    stdout += b.toString();
  });
  child.stderr?.on("data", (b: Buffer) => {
    stderr += b.toString();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  const start = Date.now();
  while (!/listening on/.test(stdout)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`api process exited before listening (stderr: ${stderr})`);
    }
    if (Date.now() - start > 30_000) {
      throw new Error(`timeout waiting for api to listen (stdout: ${stdout}, stderr: ${stderr})`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  return { child, baseUrl: `http://127.0.0.1:${opts.port}`, stdout: () => stdout, stderr: () => stderr, exited };
}

async function withTimeout<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function killAndWait(api: ApiProcess): Promise<void> {
  if (api.child.exitCode === null && api.child.signalCode === null) {
    api.child.kill("SIGKILL");
  }
  await api.exited;
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

async function createWorkflow(baseUrl: string, name: string, definition: unknown): Promise<string> {
  const r = await fetch(`${baseUrl}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, definition }),
  });
  if (!r.ok) throw new Error(`createWorkflow failed: ${r.status} ${await r.text()}`);
  const body = (await r.json()) as CreateWorkflowResponse;
  return body.id;
}

async function startRun(baseUrl: string, workflowId: string): Promise<string> {
  const r = await fetch(`${baseUrl}/api/workflows/${workflowId}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!r.ok) throw new Error(`startRun failed: ${r.status} ${await r.text()}`);
  const body = (await r.json()) as StartWorkflowRunResponse;
  return body.runId;
}

async function getRun(baseUrl: string, runId: string): Promise<GetWorkflowRunResponse> {
  const r = await fetch(`${baseUrl}/api/workflows/runs/${runId}`);
  if (!r.ok) throw new Error(`getRun failed: ${r.status} ${await r.text()}`);
  return (await r.json()) as GetWorkflowRunResponse;
}

/** Narrow a `GetWorkflowRunResponse.run.waitingOn` entry (typed `unknown[]`
 * on the wire) without a blind `as` — same object-then-field narrowing
 * pattern `routes/workflows.ts`'s `validateDefinitionInput` uses. */
function waitingOnHas(waitingOn: unknown[], kind: string, nodeId: string): boolean {
  return waitingOn.some((w) => {
    if (typeof w !== "object" || w === null) return false;
    const rec = w as Record<string, unknown>;
    return rec.kind === kind && rec.nodeId === nodeId;
  });
}

async function resolveApproval(baseUrl: string, runId: string, nodeId: string, approved: boolean): Promise<void> {
  const r = await fetch(`${baseUrl}/api/workflows/runs/${runId}/approvals/${nodeId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved }),
  });
  if (!r.ok) throw new Error(`resolveApproval failed: ${r.status} ${await r.text()}`);
}

// ── Fixture ──────────────────────────────────────────────────────────────

/**
 * `trigger -> session(start, outputSchema {answer:string}) -> approval
 * (onDeny 'fail') -> wait 2s -> stop`. The session prompt demands ONLY a
 * fenced ```json code block so `resultSchema` extraction (engine's
 * `extractStructuredOutput` — last fenced json block wins) succeeds without
 * relying on the one-shot repair path. A repair is tolerated (not a
 * failure) by the dispatchId-uniqueness assertion below, which accounts for
 * the distinct `:repair` dispatchId a repair round would add.
 */
function workflowDefinition() {
  return {
    version: "dag/v1",
    nodes: [
      { id: "trigger", type: "trigger" },
      {
        id: "ask",
        type: "session",
        mode: "start",
        model: MODEL,
        prompt:
          "Respond with ONLY a single fenced code block, nothing before or after it, in exactly this form:\n" +
          "```json\n" +
          '{"answer": "ok"}\n' +
          "```\n" +
          "Use exactly the string \"ok\" as the answer value.",
        outputSchema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
        wait: { mode: "until_idle" },
      },
      {
        id: "approve",
        type: "approval",
        prompt: "Approve the workflow run?",
        onDeny: "fail",
      },
      { id: "pause", type: "wait", mode: "duration", duration: "2s" },
      { id: "done", type: "stop" },
    ],
    edges: [
      { from: "trigger", to: "ask" },
      { from: "ask", to: "approve" },
      { from: "approve", to: "pause" },
      { from: "pause", to: "done" },
    ],
  };
}

// ── Docker container bookkeeping (best-effort cleanup only) ───────────────

function listSandboxContainers(): Set<string> {
  try {
    const out = execFileSync("docker", ["ps", "-aq", "--filter", "name=valet-sandbox-"], {
      encoding: "utf8",
    });
    return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

function removeContainers(ids: Iterable<string>): void {
  for (const id of ids) {
    try {
      execFileSync("docker", ["rm", "-f", id], { stdio: "ignore" });
    } catch {
      // best-effort
    }
  }
}

// ── Engine store dispatchId query surface (decision 21) ───────────────────
//
// These inspect the on-disk PGlite data dir directly, via a short-lived
// PGlite instance pointed at the same `VALET_PG_DATA_DIR` the spawned api
// process used. PGlite is single-connection (Task 0 finding), so this only
// runs AFTER the api process under inspection has fully exited — see the
// call site below, which kills the process before opening this reader.

interface QueueDispatchCount {
  dispatchId: string;
  count: number;
}

/** Every dispatchId under `workflow:{runId}:` must map to exactly one
 * `engine_queue_items` row — queried directly against the on-disk engine
 * pg tables. */
async function countQueueItemsByDispatchId(pglite: PGlite, runId: string): Promise<QueueDispatchCount[]> {
  const result = await pglite.query<{ dispatch_id: string; count: string }>(
    `SELECT dispatch_id, COUNT(*) as count
     FROM engine_queue_items
     WHERE dispatch_id LIKE $1
     GROUP BY dispatch_id`,
    [`workflow:${runId}:%`],
  );
  return result.rows.map((r) => ({ dispatchId: r.dispatch_id, count: Number(r.count) }));
}

interface CheckpointRow {
  node_id: string;
  iteration: number;
  count: number;
}

/** Every `(runId, nodeId, iteration)` must map to exactly one
 * `workflow_checkpoints` row. */
async function countCheckpointsByNode(pglite: PGlite, runId: string): Promise<CheckpointRow[]> {
  const result = await pglite.query<{ node_id: string; iteration: number; count: string }>(
    `SELECT node_id, iteration, COUNT(*) as count
     FROM workflow_checkpoints
     WHERE run_id = $1
     GROUP BY node_id, iteration`,
    [runId],
  );
  return result.rows.map((r) => ({ node_id: r.node_id, iteration: r.iteration, count: Number(r.count) }));
}

async function getSessionNodeResult(pglite: PGlite, runId: string, nodeId: string): Promise<unknown> {
  const result = await pglite.query<{ result: unknown }>(
    `SELECT result FROM workflow_checkpoints WHERE run_id = $1 AND node_id = $2 AND status = 'completed'`,
    [runId, nodeId],
  );
  const row = result.rows[0];
  if (!row || row.result === null || row.result === undefined) return undefined;
  // jsonb comes back already parsed by the driver — never re-parse (see
  // `fromJsonbColumn` in @valet/store-postgres).
  return row.result;
}

/** Narrow the session node's persisted result (`SessionSettledResult`,
 * `unknown` from JSON.parse) down to `output.answer` without a blind `as`. */
function extractAnswer(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const output = (result as Record<string, unknown>).output;
  if (typeof output !== "object" || output === null) return undefined;
  const answer = (output as Record<string, unknown>).answer;
  return typeof answer === "string" ? answer : undefined;
}

describeIfKey("api integration: workflow run host E2E (Phase 5 exit criterion)", () => {
  const seenContainersBeforeAll = listSandboxContainers();

  afterAll(() => {
    const after = listSandboxContainers();
    const created = [...after].filter((id) => !seenContainersBeforeAll.has(id));
    removeContainers(created);
  });

  it(
    "kill/restart at mid-node, parked-on-approval, and terminalizing — no duplicate dispatch",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "valet-wf-e2e-"));
      const pgDataDir = join(dir, "pgdata");
      const blobsRoot = join(dir, "blobs");
      const port = 20000 + Math.floor(Math.random() * 10000);

      let api: ApiProcess | undefined;
      try {
        // ── Boot process A (no crash hook). Create the definition + run 1. ──
        api = await spawnApi({ port, pgDataDir, blobsRoot });

        const workflowId = await createWorkflow(api.baseUrl, "e2e-restart-test", workflowDefinition());
        const runId1 = await startRun(api.baseUrl, workflowId);

        // ── Restart point (a): mid-node. Poll (tight interval — the window
        // is only as long as the model turn) until the run has parked on the
        // session node's submission wait (dispatch landed, turn not yet
        // settled), then SIGKILL. A fast turn can settle in under a second
        // and sail through to the approval park before any poll observes the
        // mid-node state — that's a race we lose legitimately, not a
        // failure: accept it, log it, and kill anyway (the restart +
        // no-duplicate-dispatch assertions below are the exit criterion
        // either way; the mid-node resume path stays covered by every run
        // where the turn is slower than the first few polls).
        const preKill = await poll(
          () => getRun(api!.baseUrl, runId1),
          (r) =>
            r.run.status === "parked" &&
            (waitingOnHas(r.run.waitingOn, "submission", "ask") ||
              waitingOnHas(r.run.waitingOn, "signal", "approve")),
          60_000,
          "run 1 parked (mid-node submission, or already on approval)",
          50,
        );
        const caughtMidNode = waitingOnHas(preKill.run.waitingOn, "submission", "ask");
        // eslint-disable-next-line no-console
        console.log(
          caughtMidNode
            ? "[wf-e2e] restart (a): caught mid-node (session submission in flight)"
            : "[wf-e2e] restart (a): turn settled before any poll — killing parked on approval",
        );
        await killAndWait(api);

        // ── Restart process B over the same db (the mid-node restart). The
        // session's turn (already dispatched, unsettled) resumes because
        // `restoreUnsettledSessions` + the workflow host's poll loop both
        // pick the in-flight work back up against the same PGlite data dir. ──
        api = await spawnApi({ port, pgDataDir, blobsRoot });

        // ── Restart point (b): parked-on-approval. Poll until the session
        // node completed and the run parked on the approval's signal wait,
        // then SIGKILL WITHOUT resolving it. ──
        await poll(
          () => getRun(api!.baseUrl, runId1),
          (r) =>
            r.run.status === "parked" && waitingOnHas(r.run.waitingOn, "signal", "approve"),
          180_000,
          "run 1 parked on approval",
        );
        await killAndWait(api);

        // ── Restart process C. Resolve the approval over HTTP, then poll
        // until the run proceeds through the 2s wait and settles. ──
        api = await spawnApi({ port, pgDataDir, blobsRoot });

        await poll(
          () => getRun(api!.baseUrl, runId1),
          (r) =>
            r.run.status === "parked" && waitingOnHas(r.run.waitingOn, "signal", "approve"),
          30_000,
          "run 1 re-parked on approval after restart (b)",
        );
        await resolveApproval(api.baseUrl, runId1, "approve", true);

        const run1Final = await poll(
          () => getRun(api!.baseUrl, runId1),
          (r) => r.run.status === "settled",
          30_000,
          "run 1 settled",
        );
        expect(run1Final.run.outcome).toBe("completed");

        // ── Restart point (c): terminalizing. Kill process C (run 1 is
        // already settled — no in-flight state lost), restart WITH
        // `WF_CRASH_AT=terminalizing`, drive a SECOND run of the same
        // definition, approve it promptly, and let the host crash right
        // after `beginTerminalize` on the wait node's completion (the wave
        // that resolves to `stop`). ──
        await killAndWait(api);

        api = await spawnApi({ port, pgDataDir, blobsRoot, crashAt: "terminalizing" });

        const runId2 = await startRun(api.baseUrl, workflowId);

        await poll(
          () => getRun(api!.baseUrl, runId2),
          (r) =>
            r.run.status === "parked" && waitingOnHas(r.run.waitingOn, "signal", "approve"),
          180_000,
          "run 2 parked on approval",
        );
        await resolveApproval(api.baseUrl, runId2, "approve", true);

        // The host exits 137 right after `beginTerminalize` — i.e. once the
        // wait node's timer fires and the wave resolves to `stop`. Wait for
        // the process to actually die with that code (not a normal exit).
        const exit = await withTimeout(api.exited, 60_000, "host to exit(137) after beginTerminalize (run 2)");
        expect(exit.code).toBe(137);

        // ── Restart process D WITHOUT the crash hook. The run row is stuck
        // `terminalizing` with a dead owner's lease; the poll loop's
        // expired-lease reclaim (leaseMs=30s default) picks it back up and
        // finishes the two-phase settle. ──
        api = await spawnApi({ port, pgDataDir, blobsRoot });

        const run2Final = await poll(
          () => getRun(api!.baseUrl, runId2),
          (r) => r.run.status === "settled",
          90_000,
          "run 2 settled after terminalizing-crash restart",
        );
        expect(run2Final.run.outcome).toBe("completed");

        // ── Final assertions (decision 21) — both runs. Kill process D
        // first: PGlite is single-connection (Task 0 finding), so the data
        // dir can only be safely reopened for the raw table inspection below
        // once nothing else holds it. ──
        await killAndWait(api);
        api = undefined;

        const pglite = new PGlite(pgDataDir);
        try {
          for (const runId of [runId1, runId2]) {
            const dispatchCounts = await countQueueItemsByDispatchId(pglite, runId);
            expect(dispatchCounts.length).toBeGreaterThan(0);
            for (const { dispatchId, count } of dispatchCounts) {
              expect(count, `dispatchId ${dispatchId} must map to exactly one queue item`).toBe(1);
            }

            const checkpointCounts = await countCheckpointsByNode(pglite, runId);
            expect(checkpointCounts.length).toBeGreaterThan(0);
            for (const { node_id, iteration, count } of checkpointCounts) {
              expect(count, `(${runId}, ${node_id}, ${iteration}) must have exactly one checkpoint row`).toBe(1);
            }

            const sessionResult = await getSessionNodeResult(pglite, runId, "ask");
            expect(sessionResult).toBeDefined();
            // Schema-validated output present on the session node's checkpoint
            // (decision 21) — a non-empty string satisfies `{answer: string}`;
            // not pinned to the exact value to avoid flaking on model phrasing.
            expect(extractAnswer(sessionResult)).toEqual(expect.any(String));
          }
        } finally {
          await pglite.close();
        }
      } catch (err) {
        // Surface the current child process's output — the tmp dir (and with
        // it the child's db) is deleted below, so this is the only diagnostic
        // that survives a failure.
        if (api) {
          const tail = (s: string) => s.slice(-4_000);
          console.error("=== api child stdout (tail) ===\n" + tail(api.stdout()));
          console.error("=== api child stderr (tail) ===\n" + tail(api.stderr()));
        }
        throw err;
      } finally {
        if (api) await killAndWait(api).catch(() => {});
        await rm(dir, { recursive: true, force: true });
      }
    },
    // Two full session turns (Docker + real Anthropic) plus four process
    // spawns and a terminalizing-lease reclaim wait (<=30s) comfortably fit
    // inside 10 minutes; give real headroom for slow CI/model latency.
    900_000,
  );
});
