/**
 * `make e2e` — the unified e2e entrypoint (spec:
 * docs/specs/2026-07-25-e2e-runner-design.md).
 *
 * Loads `.env.e2e` (ambient env wins), probes prerequisites once, runs each
 * armed step from `scripts/e2e/lib.ts` as a child process, and prints a
 * ✓/✗/⊘ scorecard. Exit nonzero iff an armed step failed.
 *
 * Flags:
 *   --list            print steps + armed state, run nothing
 *   --only a,b,c      run a subset (step ids)
 *   --json            machine-readable report on stdout
 *   --verbose         stream child output live (default: replay on failure)
 *
 * Deliberately NOT set here: `CI` — several docker-gated suites self-skip
 * when CI is set, and this runner is local-first.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CRED_VARS,
  missingNeeds,
  needHint,
  parseEnvFile,
  renderScorecard,
  selectSteps,
  toJsonReport,
  STEPS,
  type Probes,
  type StepDef,
  type StepResult,
} from "./e2e/lib.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── flags ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const onlyArg = ((): string[] | undefined => {
  const i = argv.indexOf("--only");
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) {
    console.error("--only requires a comma-separated list of step ids");
    process.exit(2);
  }
  return v.split(",").map((s) => s.trim()).filter((s) => s !== "");
})();
const JSON_OUT = flag("json");
const VERBOSE = flag("verbose");

// ── env loading (.env.e2e; ambient wins) ───────────────────────────────────

const envFile = resolve(ROOT, ".env.e2e");
if (existsSync(envFile)) {
  let fileVars: Record<string, string>;
  try {
    fileVars = parseEnvFile(readFileSync(envFile, "utf8"));
  } catch (err) {
    // A malformed secrets file must fail loudly, not run a weaker tier.
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  for (const [k, v] of Object.entries(fileVars)) {
    if (process.env[k] === undefined && v !== "") process.env[k] = v;
  }
}

// ── probes (cheap, read-only, once) ────────────────────────────────────────

function probeCmd(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { stdio: "ignore", timeout: 15_000 });
  return r.status === 0;
}

const probes: Probes = {
  key: Boolean(process.env.ANTHROPIC_API_KEY),
  docker: probeCmd("docker", ["info"]),
  k8sContext: probeCmd("kubectl", ["--context", "rancher-desktop", "config", "get-contexts", "rancher-desktop"]),
  e2eK8sOptIn: process.env.VALET_E2E_K8S === "1",
  telegram: Boolean(process.env.TELEGRAM_TEST_BOT_TOKEN && process.env.TELEGRAM_TEST_CHAT_ID),
  githubLive: Boolean(
    process.env.VALET_GITHUB_LIVE_TEST &&
      process.env.VALET_GITHUB_LIVE_APP_ID &&
      process.env.VALET_GITHUB_LIVE_APP_PRIVATE_KEY_PEM,
  ),
  openai: Boolean(process.env.OPENAI_API_KEY),
};

// ── step selection ─────────────────────────────────────────────────────────

let steps: StepDef[];
try {
  steps = selectSteps(STEPS, onlyArg);
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

if (flag("list")) {
  const width = Math.max(...steps.map((s) => s.id.length));
  for (const s of steps) {
    const missing = missingNeeds(s, probes);
    const state = missing.length === 0 ? "armed" : `skipped — ${missing.map(needHint).join("; ")}`;
    console.log(`${s.id.padEnd(width)}  [${s.group}]  ${state}`);
  }
  process.exit(0);
}

// ── keycloak pre-hook ──────────────────────────────────────────────────────

const KEYCLOAK_WELLKNOWN = "http://localhost:8081/realms/valet/.well-known/openid-configuration";

async function keycloakHealthy(): Promise<boolean> {
  try {
    const res = await fetch(KEYCLOAK_WELLKNOWN, { signal: AbortSignal.timeout(3_000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Boot the compose keycloak profile and wait for the realm (≤120s). The
 * container is left running between runs — cold boot is 30–60s. */
async function ensureKeycloak(): Promise<string | undefined> {
  if (await keycloakHealthy()) return undefined;
  const up = spawnSync("docker", ["compose", "--profile", "keycloak", "up", "-d", "keycloak"], {
    cwd: ROOT,
    stdio: VERBOSE ? "inherit" : "ignore",
    timeout: 120_000,
  });
  if (up.status !== 0) return "keycloak compose up failed";
  for (let i = 0; i < 60; i++) {
    if (await keycloakHealthy()) return undefined;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return "keycloak did not become healthy within 120s";
}

// ── execution ──────────────────────────────────────────────────────────────

let current: ChildProcess | undefined;
const results: StepResult[] = [];

function finish(): never {
  const report = toJsonReport(results);
  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\n${renderScorecard(results)}`);
  }
  process.exit(report.exitCode);
}

process.on("SIGINT", () => {
  if (current?.pid) {
    try {
      process.kill(-current.pid, "SIGKILL");
    } catch {}
  }
  console.error("\ninterrupted — partial scorecard:");
  finish();
});

function runStep(step: StepDef): Promise<StepResult> {
  const started = Date.now();
  const env: NodeJS.ProcessEnv = { ...process.env, ...step.env };
  if (step.scrubKeys) for (const k of CRED_VARS) delete env[k];

  return new Promise((resolveStep) => {
    const child = spawn(step.command[0], step.command.slice(1), {
      cwd: step.cwd ? resolve(ROOT, step.cwd) : ROOT,
      env,
      stdio: VERBOSE ? "inherit" : ["ignore", "pipe", "pipe"],
      detached: true, // own process group so timeouts kill the whole tree
    });
    current = child;
    let output = "";
    child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (output += d.toString()));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
    }, step.timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      current = undefined;
      const durationMs = Date.now() - started;
      const ok = code === 0 && !timedOut;
      if (!ok && !VERBOSE) process.stderr.write(`\n── ${step.id} output ──\n${output}\n`);
      if (timedOut) process.stderr.write(`── ${step.id} timed out after ${step.timeoutMs / 1000}s ──\n`);
      resolveStep({ id: step.id, status: ok ? "passed" : "failed", durationMs });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      current = undefined;
      process.stderr.write(`── ${step.id} spawn error: ${err.message} ──\n`);
      resolveStep({ id: step.id, status: "failed", durationMs: Date.now() - started });
    });
  });
}

async function main(): Promise<never> {
  for (const step of steps) {
    const missing = missingNeeds(step, probes);
    if (missing.length > 0) {
      results.push({
        id: step.id,
        status: "skipped",
        durationMs: 0,
        skipReason: missing.map(needHint).join("; "),
      });
      continue;
    }
    if (step.preHook === "keycloak") {
      const hookErr = await ensureKeycloak();
      if (hookErr !== undefined) {
        results.push({ id: step.id, status: "skipped", durationMs: 0, skipReason: hookErr });
        continue;
      }
    }
    if (!JSON_OUT) console.log(`\n▶ ${step.id} — ${step.title}`);
    results.push(await runStep(step));
  }

  finish();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
