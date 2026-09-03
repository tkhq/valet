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
 *   --doctor          environment readiness checklist, run nothing
 *   --only a,b,c      run a subset (step ids)
 *   --json            machine-readable report on stdout
 *   --verbose         stream child output live (default: replay on failure)
 *
 * Deliberately NOT set here: `CI` — several docker-gated suites self-skip
 * when CI is set, and this runner is local-first.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CRED_VARS,
  partitionWaves,
  doctorExitCode,
  truncateOutput,
  missingNeeds,
  needHint,
  parseEnvFile,
  renderDoctor,
  renderScorecard,
  selectSteps,
  toJsonReport,
  STEPS,
  type DoctorCheck,
  type Probes,
  type StepDef,
  type StepResult,
} from "./e2e/lib.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── preflight: Node >= 22 ──────────────────────────────────────────────────
// Several suites and the smoke scripts use the global `WebSocket`, which
// landed in Node 22. Under Node 20 they fail 15 minutes in with a cryptic
// "WebSocket is not defined" — fail fast here instead.
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) {
  console.error(
    `make e2e requires Node >= 22 (found ${process.versions.node}). Run \`nvm use 22\` (or \`nvm alias default 22\`) and retry.`,
  );
  process.exit(2);
}

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
    // Empty ambient values count as unset — an exported-but-blank var must
    // not shadow a real value from the file.
    const ambient = process.env[k];
    if ((ambient === undefined || ambient === "") && v !== "") process.env[k] = v;
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
  helm: probeCmd("helm", ["version"]),
  k8sContext: probeCmd("kubectl", ["--context", "rancher-desktop", "config", "get-contexts", "rancher-desktop"]),
  e2eK8sOptIn: process.env.VALET_E2E_K8S === "1",
  telegram: Boolean(process.env.TELEGRAM_TEST_BOT_TOKEN && process.env.TELEGRAM_TEST_CHAT_ID),
  githubLive: Boolean(
    process.env.VALET_GITHUB_LIVE_TEST &&
      process.env.VALET_GITHUB_LIVE_APP_ID &&
      process.env.VALET_GITHUB_LIVE_APP_PRIVATE_KEY_PEM,
  ),
  openai: Boolean(process.env.OPENAI_API_KEY),
  onepassword: Boolean(process.env.OP_SERVICE_ACCOUNT_TOKEN),
};

// ── doctor: environment readiness checklist, no suites ─────────────────────
// The "initialization phase" for a fresh machine/agent: everything a run
// needs, checked in seconds, each miss with its repair command.

if (flag("doctor")) {
  const dist = (pkg: string): boolean => existsSync(resolve(ROOT, `packages/${pkg}/dist/index.js`));
  const checks: DoctorCheck[] = [
    {
      id: "node",
      label: "Node >= 22",
      ok: true, // the preflight above already exited if not
      required: true,
      detail: `v${process.versions.node}`,
    },
    {
      id: "deps",
      label: "dependencies installed",
      ok: existsSync(resolve(ROOT, "node_modules")) && existsSync(resolve(ROOT, "packages/api/node_modules")),
      required: true,
      hint: "run `pnpm install`",
    },
    // @valet/shared and @valet/sdk are the only workspace packages consumed
    // via built dist (their package.json exports point at dist/); everything
    // else resolves TS sources directly.
    {
      id: "shared-dist",
      label: "@valet/shared built",
      ok: dist("shared"),
      required: true,
      hint: "run `pnpm --filter @valet/shared build`",
    },
    {
      id: "sdk-dist",
      label: "@valet/sdk built",
      ok: dist("sdk"),
      required: true,
      hint: "run `pnpm --filter @valet/sdk build`",
    },
    {
      id: "env-file",
      label: ".env.e2e present",
      ok: existsSync(envFile),
      required: false,
      hint: "cp .env.e2e.example .env.e2e and fill in credentials (keyless tiers still run)",
    },
    { id: "key", label: "Anthropic key", ok: probes.key, required: false, hint: needHint("key") },
    { id: "docker", label: "Docker daemon", ok: probes.docker, required: false, hint: needHint("docker") },
    { id: "helm", label: "helm CLI", ok: probes.helm, required: false, hint: "install helm (brew install helm)" },
    { id: "k8s", label: "kubectl context rancher-desktop", ok: probes.k8sContext, required: false, hint: needHint("k8sContext") },
    { id: "k8s-opt-in", label: "k8s fullstack opt-in", ok: probes.e2eK8sOptIn, required: false, hint: needHint("e2eK8sOptIn") },
    { id: "telegram", label: "Telegram creds", ok: probes.telegram, required: false, hint: needHint("telegram") },
    { id: "github-live", label: "GitHub live-App creds", ok: probes.githubLive, required: false, hint: needHint("githubLive") },
    { id: "openai", label: "OpenAI key", ok: probes.openai, required: false, hint: needHint("openai") },
    { id: "onepassword", label: "1Password service-account token", ok: probes.onepassword, required: false, hint: needHint("onepassword") },
  ];
  const armed = STEPS.filter((s) => missingNeeds(s, probes).length === 0).length;
  console.log(renderDoctor(checks, armed, STEPS.length));
  process.exit(doctorExitCode(checks));
}

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

// parallelSafe static steps run in a small pool (see lib.ts partitionWaves).
// Each vitest child spawns its own workers, so the pool stays small; override
// with VALET_E2E_JOBS. --verbose forces 1 (inherited stdio cannot interleave).
const JOBS = VERBOSE
  ? 1
  : (() => {
      const fromEnv = Number(process.env.VALET_E2E_JOBS);
      if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
      return Math.min(4, Math.max(2, Math.floor(availableParallelism() / 4)));
    })();

const running = new Map<string, ChildProcess>();
const resultsById = new Map<string, StepResult>();

function orderedResults(): StepResult[] {
  return steps.filter((s) => resultsById.has(s.id)).map((s) => resultsById.get(s.id) as StepResult);
}

function finish(extraExit = 0): never {
  const report = toJsonReport(orderedResults());
  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\n${renderScorecard(orderedResults())}`);
  }
  process.exit(report.exitCode || extraExit);
}

process.on("SIGINT", () => {
  // Every in-flight step is recorded as failed so an interrupted run can
  // NEVER exit 0 and read as green downstream.
  for (const [id, child] of running) {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    resultsById.set(id, { id, status: "failed", durationMs: 0, skipReason: undefined });
  }
  console.error("\ninterrupted — partial scorecard:");
  finish(130);
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
    running.set(step.id, child);
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
      running.delete(step.id);
      const durationMs = Date.now() - started;
      const ok = code === 0 && !timedOut;
      if (!ok && !VERBOSE) {
        process.stderr.write(`\n── ${step.id} output ──\n${truncateOutput(output)}\n`);
      }
      if (timedOut) process.stderr.write(`── ${step.id} timed out after ${step.timeoutMs / 1000}s ──\n`);
      resolveStep({ id: step.id, status: ok ? "passed" : "failed", durationMs });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      running.delete(step.id);
      process.stderr.write(`── ${step.id} spawn error: ${err.message} ──\n`);
      resolveStep({ id: step.id, status: "failed", durationMs: Date.now() - started });
    });
  });
}

/** Skip-gate a step; returns true when it should run. */
function gate(step: StepDef): boolean {
  const missing = missingNeeds(step, probes);
  if (missing.length > 0) {
    resultsById.set(step.id, {
      id: step.id,
      status: "skipped",
      durationMs: 0,
      skipReason: missing.map(needHint).join("; "),
    });
    return false;
  }
  return true;
}

async function runSerial(step: StepDef): Promise<void> {
  if (!gate(step)) return;
  if (step.preHook === "keycloak") {
    const hookErr = await ensureKeycloak();
    if (hookErr !== undefined) {
      resultsById.set(step.id, { id: step.id, status: "skipped", durationMs: 0, skipReason: hookErr });
      return;
    }
  }
  if (!JSON_OUT) console.log(`\n▶ ${step.id} — ${step.title}`);
  resultsById.set(step.id, await runStep(step));
}

/** Run `pool` steps with at most JOBS in flight. */
async function runPool(pool: StepDef[]): Promise<void> {
  const queue = pool.filter(gate);
  const workers = Array.from({ length: Math.min(JOBS, queue.length) }, async () => {
    for (;;) {
      const step = queue.shift();
      if (!step) return;
      if (!JSON_OUT) console.log(`▶ ${step.id} — ${step.title}`);
      resultsById.set(step.id, await runStep(step));
    }
  });
  await Promise.all(workers);
}

async function main(): Promise<never> {
  const waves = partitionWaves(steps);
  for (const step of waves.pre) await runSerial(step);
  if (waves.parallel.length > 0) {
    if (!JSON_OUT) console.log(`\n── static pool (${JOBS} jobs) ──`);
    await runPool(waves.parallel);
  }
  for (const step of waves.serial) await runSerial(step);

  finish();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
