/**
 * Task 0 (GATE): does PGlite survive a SIGKILL mid-write without losing
 * committed data or acknowledging a write that never lands?
 *
 * Shape ported from packages/store-sqlite/experiments/fencing-spike.ts: a
 * WRITER child process opens a fresh PGlite data dir and loops
 * single-transaction inserts of (seq, checksum) rows, appending each
 * COMMIT-acknowledged seq to an fsync'd plain-text ack log AFTER the commit
 * promise resolves. The parent SIGKILLs it at a randomized 50-500ms delay
 * (measured from the child's READY signal, not from spawn — PGlite cold
 * boot takes seconds), then spawns a VALIDATOR child that reopens the same
 * data dir with a fresh PGlite and asserts:
 *   (a) the reopened DB opens without error
 *   (b) every row's checksum is valid (no silent corruption)
 *   (c) every acknowledged seq is present in the DB (acked-but-missing is
 *       the durability violation this spike exists to catch)
 *
 * Both the writer and the validator run as subprocesses because PGlite's
 * wasm heap is not reliably released by close(); reopening 60 databases in
 * one long-lived parent balloons its RSS into the multi-GB range and drove
 * the host into uninterruptible disk-wait in early runs.
 *
 * Run (from repo root):
 *   pnpm --filter @valet/store-postgres exec tsx experiments/durability-spike.ts
 *
 * See FINDINGS-pglite-durability.md for results and the verdict.
 */
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, fsyncSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);

function checksum(seq: number, salt: string): string {
  return createHash("sha256").update(`${seq}:${salt}`).digest("hex");
}

interface ValidationReport {
  opened: boolean;
  openError?: string;
  tableMissing?: boolean;
  dbRowCount: number;
  maxDbSeq: number;
  dbSeqs: number[];
  checksumFailures: string[];
  reopenMs: number;
}

// ---------------------------------------------------------------------------
// Writer child: spawned with SPIKE_MODE=writer. Opens PGlite, loops
// single-transaction inserts as fast as it can, fsyncs an ack log after each
// COMMIT resolves. Killed by the parent with SIGKILL — no graceful shutdown,
// which is the entire point.
// ---------------------------------------------------------------------------
async function writerMain(): Promise<void> {
  const { PGlite } = await import("@electric-sql/pglite");
  const dataDir = process.env.SPIKE_DATA_DIR;
  const ackLogPath = process.env.SPIKE_ACK_LOG;
  const salt = process.env.SPIKE_SALT;
  const relaxedDurability = process.env.SPIKE_RELAXED === "1";
  if (!dataDir || !ackLogPath || !salt) {
    throw new Error("missing SPIKE_DATA_DIR / SPIKE_ACK_LOG / SPIKE_SALT env vars");
  }

  const db = await PGlite.create(dataDir, { relaxedDurability });
  await db.exec(`CREATE TABLE IF NOT EXISTS spike_rows (seq INTEGER PRIMARY KEY, checksum TEXT NOT NULL)`);

  const ackFd = openSync(ackLogPath, "a");

  // PGlite cold-start (wasm instantiation + initdb-equivalent boot) takes
  // seconds in a fresh process — far longer than the 50-500ms kill window we
  // want to land mid-insert-loop. Signal readiness on stdout so the parent
  // starts its kill timer only once the loop is actually running.
  process.stdout.write("READY\n");

  let seq = 0;
  // Loop until SIGKILL. No delay between iterations — maximum write pressure
  // so the randomized kill window reliably lands mid-stream.
  for (;;) {
    seq += 1;
    const sum = checksum(seq, salt);
    await db.transaction(async (tx) => {
      await tx.query("INSERT INTO spike_rows (seq, checksum) VALUES ($1, $2)", [seq, sum]);
    });
    // Ack ONLY after the commit promise has resolved, and fsync the ack
    // write itself so a kill immediately after this line doesn't lose the
    // ack (that would be a false negative for us, not a PGlite violation).
    writeSync(ackFd, `${seq}\n`);
    fsyncSync(ackFd);
  }
}

// ---------------------------------------------------------------------------
// Validator child: spawned with SPIKE_MODE=validate. Reopens the data dir
// with a fresh PGlite, dumps rows + checksum failures as JSON on stdout,
// exits. Runs out-of-process so wasm memory dies with it.
// ---------------------------------------------------------------------------
async function validatorMain(): Promise<void> {
  const { PGlite } = await import("@electric-sql/pglite");
  const dataDir = process.env.SPIKE_DATA_DIR;
  const salt = process.env.SPIKE_SALT;
  const relaxedDurability = process.env.SPIKE_RELAXED === "1";
  if (!dataDir || !salt) throw new Error("missing SPIKE_DATA_DIR / SPIKE_SALT env vars");

  const report: ValidationReport = {
    opened: false,
    dbRowCount: 0,
    maxDbSeq: 0,
    dbSeqs: [],
    checksumFailures: [],
    reopenMs: 0,
  };

  const t0 = Date.now();
  try {
    const db = await PGlite.create(dataDir, { relaxedDurability });
    report.reopenMs = Date.now() - t0;
    report.opened = true;
    try {
      const res = await db.query<{ seq: number; checksum: string }>("SELECT seq, checksum FROM spike_rows");
      report.dbRowCount = res.rows.length;
      for (const row of res.rows) {
        report.dbSeqs.push(row.seq);
        if (row.seq > report.maxDbSeq) report.maxDbSeq = row.seq;
        const expected = checksum(row.seq, salt);
        if (row.checksum !== expected) {
          report.checksumFailures.push(`seq=${row.seq} expected ${expected} got ${row.checksum}`);
        }
      }
    } catch (err) {
      // Table missing is only OK if nothing was ever acked; parent decides.
      report.tableMissing = true;
      report.openError = String(err);
    }
    await db.close();
  } catch (err) {
    report.reopenMs = Date.now() - t0;
    report.opened = false;
    report.openError = String(err);
  }

  process.stdout.write(`REPORT ${JSON.stringify(report)}\n`);
}

// ---------------------------------------------------------------------------
// Parent mode: runs kill cycles against one configuration.
// ---------------------------------------------------------------------------
interface CycleResult {
  cycle: number;
  ackedCount: number;
  maxAcked: number;
  dbRowCount: number;
  maxDbSeq: number;
  violations: string[];
  reopenMs: number;
  readySignaled: boolean;
  readyMs: number;
  writerReaped: boolean;
}

function spawnMode(
  mode: "writer" | "validate",
  dataDir: string,
  ackLogPath: string,
  salt: string,
  relaxedDurability: boolean,
): ChildProcess {
  // IMPORTANT: do NOT spawn via tsx/cli — the tsx CLI re-execs node as a
  // grandchild, so SIGKILLing the spawned pid killed only the wrapper and
  // orphaned the actual PGlite writer (which kept inserting forever and
  // degraded the whole host across cycles). `node --import <loader>` runs
  // the script in the process we spawned, so the SIGKILL is real. detached
  // gives it its own process group so we can group-kill as a backstop.
  const loader = require.resolve("tsx");
  return spawn(process.execPath, ["--import", loader, __filename], {
    detached: true,
    env: {
      ...process.env,
      SPIKE_MODE: mode,
      SPIKE_DATA_DIR: dataDir,
      SPIKE_ACK_LOG: ackLogPath,
      SPIKE_SALT: salt,
      SPIKE_RELAXED: relaxedDurability ? "1" : "0",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/** SIGKILL the child's whole process group (backstop: the pid itself). */
function killHard(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** Resolves once the child prints READY, exits, or a 30s cap elapses. */
function waitForReady(child: ChildProcess): Promise<{ signaled: boolean; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const done = (signaled: boolean) => {
      if (!settled) {
        settled = true;
        clearTimeout(cap);
        resolve({ signaled, ms: Date.now() - t0 });
      }
    };
    const cap = setTimeout(() => done(false), 30_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("READY")) done(true);
    });
    child.once("exit", () => done(false));
  });
}

/** Waits for exit up to capMs; a SIGKILL'd process runs no further user code
 *  even if the kernel is slow to reap it, so proceeding is safe. */
function waitForExit(child: ChildProcess, capMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const cap = setTimeout(() => resolve(false), capMs);
    child.once("exit", () => {
      clearTimeout(cap);
      resolve(true);
    });
  });
}

/** Runs the validator subprocess and parses its REPORT line. */
function runValidator(
  dataDir: string,
  salt: string,
  relaxedDurability: boolean,
): Promise<ValidationReport | { spawnFailure: string }> {
  return new Promise((resolve) => {
    const child = spawnMode("validate", dataDir, "", salt, relaxedDurability);
    let out = "";
    let settled = false;
    const done = (v: ValidationReport | { spawnFailure: string }) => {
      if (!settled) {
        settled = true;
        clearTimeout(cap);
        resolve(v);
      }
    };
    const cap = setTimeout(() => {
      killHard(child);
      done({ spawnFailure: "validator timed out after 60s" });
    }, 60_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.once("exit", () => {
      const line = out.split("\n").find((l) => l.startsWith("REPORT "));
      if (!line) return done({ spawnFailure: `validator exited without REPORT (stdout: ${out.slice(0, 200)})` });
      try {
        done(JSON.parse(line.slice("REPORT ".length)) as ValidationReport);
      } catch (err) {
        done({ spawnFailure: `unparseable REPORT: ${String(err)}` });
      }
    });
  });
}

function randomDelayMs(): number {
  return 50 + Math.floor(Math.random() * 450); // [50, 500)
}

async function runCycle(cycleIndex: number, relaxedDurability: boolean): Promise<CycleResult> {
  const cycleRoot = mkdtempSync(join(tmpdir(), "pglite-durability-"));
  const dataDir = join(cycleRoot, "pgdata");
  const ackLogPath = join(cycleRoot, "ack.log");
  const salt = `${cycleIndex}-${Math.random().toString(36).slice(2)}`;

  const writer = spawnMode("writer", dataDir, ackLogPath, salt, relaxedDurability);
  const ready = await waitForReady(writer);
  await new Promise((resolve) => setTimeout(resolve, randomDelayMs()));
  killHard(writer);
  const writerReaped = await waitForExit(writer, 10_000);

  const acked: number[] = existsSync(ackLogPath)
    ? readFileSync(ackLogPath, "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => Number.parseInt(l, 10))
    : [];
  const maxAcked = acked.length > 0 ? Math.max(...acked) : 0;

  const violations: string[] = [];
  const report = await runValidator(dataDir, salt, relaxedDurability);

  let dbRowCount = 0;
  let maxDbSeq = 0;
  let reopenMs = -1;

  if ("spawnFailure" in report) {
    violations.push(`VALIDATOR FAILURE: ${report.spawnFailure}`);
  } else {
    reopenMs = report.reopenMs;
    if (!report.opened) {
      violations.push(`DB FAILED TO REOPEN: ${report.openError}`);
    } else {
      if (report.tableMissing && acked.length > 0) {
        violations.push(
          `spike_rows table missing on reopen but ${acked.length} seq(s) were acked: ${report.openError}`,
        );
      }
      dbRowCount = report.dbRowCount;
      maxDbSeq = report.maxDbSeq;
      violations.push(...report.checksumFailures.map((f) => `checksum mismatch: ${f}`));
      const dbSeqs = new Set(report.dbSeqs);
      for (const seq of acked) {
        if (!dbSeqs.has(seq)) {
          violations.push(`seq=${seq} was acked (commit resolved + ack fsync'd) but is MISSING from reopened DB`);
        }
      }
    }
  }

  // Cleanup with retries — PGlite/emscripten can release fds a tick late.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(cycleRoot, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  return {
    cycle: cycleIndex,
    ackedCount: acked.length,
    maxAcked,
    dbRowCount,
    maxDbSeq,
    violations,
    reopenMs,
    readySignaled: ready.signaled,
    readyMs: ready.ms,
    writerReaped,
  };
}

async function runSuite(label: string, relaxedDurability: boolean, cycles: number): Promise<CycleResult[]> {
  console.log(`\n=== ${label}, ${cycles} cycles ===`);
  const results: CycleResult[] = [];
  for (let i = 1; i <= cycles; i++) {
    const r = await runCycle(i, relaxedDurability);
    results.push(r);
    const status = r.violations.length === 0 ? "ok" : `VIOLATION x${r.violations.length}`;
    console.log(
      `  cycle ${i}/${cycles}: ready=${r.readySignaled ? "yes" : "CAPPED"}(${r.readyMs}ms) reaped=${r.writerReaped} acked=${r.ackedCount} (max=${r.maxAcked}) dbRows=${r.dbRowCount} (max=${r.maxDbSeq}) reopenMs=${r.reopenMs} — ${status}`,
    );
    for (const v of r.violations) console.log(`    ! ${v}`);
  }
  return results;
}

async function parentMain(): Promise<void> {
  const t0 = Date.now();

  const durableCycles = Number.parseInt(process.env.SPIKE_DURABLE_CYCLES ?? "50", 10);
  const relaxedCycles = Number.parseInt(process.env.SPIKE_RELAXED_CYCLES ?? "10", 10);

  // Primary run: the most durable configuration available —
  // relaxedDurability explicitly false. Under Node/NodeFS this equals the
  // default (relaxedDurability governs IndexedDB flush scheduling in
  // browser filesystems; NodeFS mounts the host filesystem directly).
  const durable = await runSuite("durable (relaxedDurability=false)", false, durableCycles);

  // Secondary comparison run: relaxedDurability=true, to check empirically
  // whether it changes crash behavior under NodeFS at all.
  const relaxed = await runSuite("relaxed (relaxedDurability=true)", true, relaxedCycles);

  const totalMs = Date.now() - t0;
  const durableViolations = durable.flatMap((r) => r.violations);
  const relaxedViolations = relaxed.flatMap((r) => r.violations);
  const avg = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length);

  console.log("\n--- summary ---");
  console.log(`durable config: ${durable.length} cycles, ${durableViolations.length} violations`);
  console.log(`relaxed config: ${relaxed.length} cycles, ${relaxedViolations.length} violations`);
  console.log(`max committed seq (durable): ${Math.max(...durable.map((r) => r.maxDbSeq), 0)}`);
  console.log(`max committed seq (relaxed): ${Math.max(...relaxed.map((r) => r.maxDbSeq), 0)}`);
  console.log(`avg reopen ms (durable): ${avg(durable.filter((r) => r.reopenMs >= 0).map((r) => r.reopenMs)).toFixed(1)}`);
  console.log(`total runtime: ${(totalMs / 1000).toFixed(1)}s`);

  // Machine-readable summary for the findings file.
  console.log(
    "\nSPIKE_RESULT_JSON " +
      JSON.stringify({
        durable: {
          cycles: durable.length,
          violations: durableViolations,
          maxSeq: Math.max(...durable.map((r) => r.maxDbSeq), 0),
          totalAcked: durable.reduce((s, r) => s + r.ackedCount, 0),
          totalDbRows: durable.reduce((s, r) => s + r.dbRowCount, 0),
          avgReopenMs: avg(durable.filter((r) => r.reopenMs >= 0).map((r) => r.reopenMs)),
        },
        relaxed: {
          cycles: relaxed.length,
          violations: relaxedViolations,
          maxSeq: Math.max(...relaxed.map((r) => r.maxDbSeq), 0),
          totalAcked: relaxed.reduce((s, r) => s + r.ackedCount, 0),
          totalDbRows: relaxed.reduce((s, r) => s + r.dbRowCount, 0),
          avgReopenMs: avg(relaxed.filter((r) => r.reopenMs >= 0).map((r) => r.reopenMs)),
        },
        totalMs,
      }),
  );

  if (durableViolations.length > 0) process.exitCode = 1;
}

const mode = process.env.SPIKE_MODE;
if (mode === "writer") {
  writerMain().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (mode === "validate") {
  validatorMain().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  parentMain().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
