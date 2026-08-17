/**
 * `fullstack-docker` step: spawn a REAL `valet serve`-equivalent api process
 * (docker sandbox backend, fresh data dir, stub local auth), wait for health,
 * then drive it from outside via the shared scenario. Unlike `smoke:session`
 * (in-process app), this exercises the real server boot path and the wire
 * surface end to end. Exit 0/1.
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "./fullstack-scenario.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = 18790 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;
// The workspace below is bind-mounted into a docker sandbox. A VM-backed
// daemon (Docker Desktop, Colima, Rancher Desktop) shares the home directory
// but not `/tmp`, and mounts an empty directory instead of failing. This
// mirrors `sandboxWorkspaceRoot()` in @valet/sandbox-docker, which this
// script cannot import — the repo root declares no workspace dependencies.
const SCRATCH = join(homedir(), ".valet", "workspaces", "e2e-fullstack");
const DATA_DIR = `${SCRATCH}/data`;
const WORKSPACE = `${SCRATCH}/ws`;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required.");
  process.exit(1);
}

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(WORKSPACE, { recursive: true });

const serverEnv: NodeJS.ProcessEnv = {
  ...process.env,
  PORT: String(PORT),
  VALET_LOCAL_AUTH: "1",
  VALET_DATA_DIR: DATA_DIR,
};
// This step runs the api on STUB auth. An ambient BETTER_AUTH_SECRET (e.g.
// from .env.e2e) would pair real auth with the stub above, which the api
// refuses to boot (see packages/api/src/auth/config.ts).
delete serverEnv.BETTER_AUTH_SECRET;

const child = spawn("pnpm", ["--filter", "@valet/api", "start"], {
  cwd: ROOT,
  env: serverEnv,
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
let serverOutput = "";
child.stdout?.on("data", (d: Buffer) => (serverOutput += d.toString()));
child.stderr?.on("data", (d: Buffer) => (serverOutput += d.toString()));

function killServer(): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
}

async function waitForHealth(deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
    } catch {}
    if (child.exitCode !== null) {
      throw new Error(`server exited early (code ${child.exitCode})\n${serverOutput}`);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`server not healthy within ${deadlineMs / 1000}s\n${serverOutput}`);
}

async function main(): Promise<number> {
  try {
    await waitForHealth(90_000);
    const { sessionId } = await runScenario({ baseUrl: BASE, workspace: WORKSPACE });
    // Delete the session BEFORE killing the server: teardown is SIGKILL, so
    // this is the only chance to destroy the session's Docker sandbox
    // container — otherwise one orphan container leaks per run.
    const del = await fetch(`${BASE}/api/sessions/${sessionId}`, { method: "DELETE" });
    console.log(`[fullstack-docker] session cleanup: ${del.status}`);
    console.log("[fullstack-docker] PASS");
    return 0;
  } catch (err) {
    console.error(`[fullstack-docker] FAIL: ${err instanceof Error ? err.message : String(err)}`);
    // Replay the server log on failure to make diagnosis possible.
    console.error(`── server output ──\n${serverOutput}`);
    return 1;
  } finally {
    killServer();
  }
}

main().then((code) => process.exit(code));
