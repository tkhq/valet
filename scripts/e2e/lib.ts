/**
 * Pure library behind `scripts/e2e.ts` (`make e2e`): the step table, probe
 * gating, `.env.e2e` parsing, and scorecard rendering. No child processes and
 * no fs here — everything is unit-testable (`lib.test.ts`).
 *
 * Spec: docs/specs/2026-07-25-e2e-runner-design.md
 */

export type Need =
  | "key"
  | "docker"
  | "k8sContext"
  | "e2eK8sOptIn"
  | "telegram"
  | "githubLive"
  | "openai";

export interface StepDef {
  id: string;
  group: "static" | "integration" | "docker" | "fullstack" | "live";
  title: string;
  /** argv, spawned without a shell. */
  command: string[];
  /** Working directory relative to repo root; default ".". */
  cwd?: string;
  needs: Need[];
  /** Extra env for the child (e.g. VALET_CLI_E2E=1). */
  env?: Record<string, string>;
  /** Remove credential vars from the child env (integration-core: makes the
   * key-gated describe.skip branches skip deterministically). */
  scrubKeys?: boolean;
  /** Runner-side pre-hook id (only "keycloak" today). */
  preHook?: "keycloak";
  timeoutMs: number;
}

export interface Probes {
  key: boolean;
  docker: boolean;
  k8sContext: boolean;
  e2eK8sOptIn: boolean;
  telegram: boolean;
  githubLive: boolean;
  openai: boolean;
}

/** Env vars scrubbed from `scrubKeys` steps and probed for cred tiers. */
export const CRED_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "TELEGRAM_TEST_BOT_TOKEN",
  "TELEGRAM_TEST_CHAT_ID",
  "VALET_GITHUB_LIVE_TEST",
  "VALET_GITHUB_LIVE_APP_ID",
  "VALET_GITHUB_LIVE_APP_PRIVATE_KEY_PEM",
] as const;

const MIN = 60_000;

/** Integration files run keyless in `integration-core` (key-gated suites in
 * these files self-skip via describe.skip). Explicit lists so the two
 * integration rows stay disjoint from the dedicated rows (cli, telegram,
 * github-live, openai, prebuilds, keycloak). */
const INTEGRATION_CORE_FILES = [
  "src/integration/auth.e2e.test.ts",
  "src/integration/memory-routes.test.ts",
  "src/integration/memory-tree.test.ts",
  "src/integration/sessions-list-filter.test.ts",
  "src/integration/reload-tool-rendering.test.ts",
  "src/integration/workflow-engine-deps.test.ts",
  "src/integration/orchestrator-info.test.ts",
  "src/integration/github-repo.e2e.test.ts",
];

const INTEGRATION_AGENT_FILES = [
  "src/integration/orchestrator.test.ts",
  "src/integration/orchestrator-loop.test.ts",
  "src/integration/orchestrator-children.test.ts",
  "src/integration/orchestrator-restart.test.ts",
  "src/integration/cross-thread.test.ts",
  "src/integration/plugins.e2e.test.ts",
  "src/integration/workflow-run.e2e.test.ts",
];

/** Plugin packages that HAVE test files. Content-only plugins ship a bare
 * `vitest run` script with no config/tests, which explodes resolving the
 * ROOT workspace config from the wrong cwd — enumerate instead of globbing.
 * A new plugin gaining tests must be added here (guarded by lib.test.ts). */
const TESTED_PLUGINS = [
  "@valet/plugin-github",
  "@valet/plugin-gmail",
  "@valet/plugin-google-calendar",
  "@valet/plugin-google-workspace",
  "@valet/plugin-linear",
  "@valet/plugin-slack",
  "@valet/plugin-telegram",
];

const apiTest = (...files: string[]): string[] => [
  "pnpm",
  "--filter",
  "@valet/api",
  "test",
  "--",
  ...files,
];

export const STEPS: StepDef[] = [
  // ── static + unit ────────────────────────────────────────────────────────
  { id: "typecheck", group: "static", title: "root typecheck (all packages)", command: ["pnpm", "typecheck"], needs: [], scrubKeys: true, timeoutMs: 10 * MIN },
  { id: "unit", group: "static", title: "root unit sweep (shared, sdk, api, web)", command: ["pnpm", "test"], needs: [], scrubKeys: true, timeoutMs: 15 * MIN },
  { id: "engine-unit", group: "static", title: "engine unit suite", command: ["pnpm", "--filter", "@valet/engine", "test"], needs: [], scrubKeys: true, timeoutMs: 10 * MIN },
  { id: "workflow-unit", group: "static", title: "workflow interpreter suite", command: ["pnpm", "--filter", "@valet/workflow", "test"], needs: [], scrubKeys: true, timeoutMs: 10 * MIN },
  { id: "gateway-unit", group: "static", title: "sandbox gateway (JWT, WS proxy)", command: ["pnpm", "--filter", "@valet/sandbox-gateway", "test"], needs: [], scrubKeys: true, timeoutMs: 10 * MIN },
  { id: "runner-unit", group: "static", title: "runner suite", command: ["pnpm", "--filter", "@valet/runner", "test"], needs: [], scrubKeys: true, timeoutMs: 10 * MIN },
  { id: "plugins-unit", group: "static", title: "plugin package suites", command: ["pnpm", ...TESTED_PLUGINS.flatMap((n) => ["--filter", n]), "test"], needs: [], scrubKeys: true, timeoutMs: 15 * MIN },
  { id: "sandbox-local", group: "static", title: "sandbox-local suite", command: ["pnpm", "--filter", "@valet/sandbox-local", "test"], needs: [], scrubKeys: true, timeoutMs: 10 * MIN },

  // ── integration + smoke ──────────────────────────────────────────────────
  { id: "integration-core", group: "integration", title: "keyless api integration", command: apiTest(...INTEGRATION_CORE_FILES), needs: [], scrubKeys: true, timeoutMs: 15 * MIN },
  { id: "orchestrator-smoke", group: "integration", title: "orchestrator smoke (real turn)", command: ["pnpm", "--filter", "@valet/api", "smoke:orchestrator"], needs: ["key"], timeoutMs: 5 * MIN },
  { id: "session-smoke", group: "integration", title: "session smoke (Docker round-trip)", command: ["pnpm", "--filter", "@valet/api", "smoke:session"], needs: ["key", "docker"], timeoutMs: 10 * MIN },
  { id: "integration-agent", group: "integration", title: "key-gated api integration", command: apiTest(...INTEGRATION_AGENT_FILES), needs: ["key"], timeoutMs: 30 * MIN },
  { id: "cli", group: "integration", title: "CLI e2e (T9)", command: apiTest("src/integration/cli.e2e.test.ts"), needs: [], env: { VALET_CLI_E2E: "1" }, timeoutMs: 15 * MIN },

  // ── docker / cluster gated ───────────────────────────────────────────────
  { id: "sandbox-docker", group: "docker", title: "sandbox-docker suite", command: ["pnpm", "--filter", "@valet/sandbox-docker", "test"], needs: ["docker"], timeoutMs: 15 * MIN },
  { id: "sandbox-k8s", group: "docker", title: "sandbox-kubernetes cluster suite", command: ["pnpm", "--filter", "@valet/sandbox-kubernetes", "test"], needs: ["k8sContext"], timeoutMs: 20 * MIN },
  { id: "store-postgres", group: "docker", title: "real-Postgres conformance", command: ["make", "test-pg"], needs: ["docker"], timeoutMs: 15 * MIN },
  { id: "workspace-prep-docker", group: "docker", title: "workspace prep against real sandbox", command: apiTest("src/engine/workspace-prep.docker.test.ts", "src/engine/workspace-prep-prebuilt.docker.test.ts"), needs: ["docker"], timeoutMs: 15 * MIN },
  { id: "prebuilds-docker", group: "docker", title: "image prebuild pipeline", command: apiTest("src/integration/prebuilds.e2e.test.ts"), needs: ["docker"], timeoutMs: 20 * MIN },
  { id: "k8s-builder-cluster", group: "docker", title: "in-cluster image build", command: apiTest("src/prebuilds/k8s-builder.cluster.test.ts"), needs: ["k8sContext"], timeoutMs: 20 * MIN },
  { id: "keycloak-oidc", group: "docker", title: "Keycloak OIDC code flow", command: apiTest("src/integration/oidc-keycloak.e2e.test.ts"), needs: ["docker"], preHook: "keycloak", timeoutMs: 10 * MIN },

  // ── full stack ───────────────────────────────────────────────────────────
  { id: "fullstack-docker", group: "fullstack", title: "full stack: spawned serve + docker sandbox", command: ["pnpm", "exec", "tsx", "scripts/e2e/fullstack-docker.ts"], needs: ["key", "docker"], timeoutMs: 10 * MIN },
  { id: "fullstack-k8s", group: "fullstack", title: "full stack: helm on rancher-desktop", command: ["pnpm", "exec", "tsx", "scripts/e2e/fullstack-k8s.ts"], needs: ["key", "k8sContext", "e2eK8sOptIn"], timeoutMs: 40 * MIN },

  // ── live external ────────────────────────────────────────────────────────
  { id: "telegram", group: "live", title: "live Telegram outbound", command: apiTest("src/integration/telegram.e2e.test.ts"), needs: ["telegram"], timeoutMs: 10 * MIN },
  { id: "github-live", group: "live", title: "live GitHub App", command: apiTest("src/integration/github-repo.e2e.test.ts"), needs: ["githubLive"], timeoutMs: 10 * MIN },
  { id: "openai", group: "live", title: "OpenAI provider path", command: apiTest("src/integration/llm-providers.e2e.test.ts"), needs: ["openai"], timeoutMs: 10 * MIN },
];

/** Needs not satisfied by the current probes ([] ⇒ armed). */
export function missingNeeds(step: StepDef, probes: Probes): Need[] {
  return step.needs.filter((n) => !probes[n]);
}

/** Human hint for a missing need — names the exact vars/prereq to fix. */
export function needHint(n: Need): string {
  switch (n) {
    case "key":
      return "set ANTHROPIC_API_KEY";
    case "docker":
      return "Docker daemon not reachable";
    case "k8sContext":
      return "kubectl context rancher-desktop not found";
    case "e2eK8sOptIn":
      return "set VALET_E2E_K8S=1";
    case "telegram":
      return "set TELEGRAM_TEST_BOT_TOKEN + TELEGRAM_TEST_CHAT_ID";
    case "githubLive":
      return "set VALET_GITHUB_LIVE_TEST=1 + VALET_GITHUB_LIVE_APP_ID + VALET_GITHUB_LIVE_APP_PRIVATE_KEY_PEM";
    case "openai":
      return "set OPENAI_API_KEY";
  }
}

/**
 * Parse a `.env.e2e` file: `KEY=VALUE` lines, `#` comments, blank lines.
 * Throws on any other line — a malformed secrets file must fail loudly, not
 * silently run a weaker tier (spec: error handling).
 */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) throw new Error(`.env.e2e line ${i + 1}: expected KEY=VALUE, got "${line}"`);
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export interface StepResult {
  id: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  skipReason?: string;
}

const ICON: Record<StepResult["status"], string> = { passed: "✓", failed: "✗", skipped: "⊘" };

/** Render the human scorecard: one line per step + totals. */
export function renderScorecard(results: StepResult[]): string {
  const width = Math.max(...results.map((r) => r.id.length));
  const lines = results.map((r) => {
    const secs = (r.durationMs / 1000).toFixed(1);
    const tail =
      r.status === "skipped" ? `skipped — ${r.skipReason ?? "unknown"}` : `${r.status} (${secs}s)`;
    return `${ICON[r.status]} ${r.id.padEnd(width)}  ${tail}`;
  });
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  lines.push("");
  lines.push(`${passed} passed · ${failed} failed · ${skipped} skipped`);
  return lines.join("\n");
}

export interface JsonReport {
  steps: StepResult[];
  passed: number;
  failed: number;
  skipped: number;
  exitCode: number;
}

/** Machine-readable report; exitCode 1 iff any armed step failed. */
export function toJsonReport(results: StepResult[]): JsonReport {
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  return { steps: results, passed, failed, skipped, exitCode: failed > 0 ? 1 : 0 };
}

/** Apply `--only`: keep listed step ids (order preserved); throw on unknown. */
export function selectSteps(all: StepDef[], only?: string[]): StepDef[] {
  if (!only || only.length === 0) return all;
  const known = new Set(all.map((s) => s.id));
  for (const id of only) {
    if (!known.has(id)) throw new Error(`unknown step "${id}" (see --list for step ids)`);
  }
  const wanted = new Set(only);
  return all.filter((s) => wanted.has(s.id));
}
