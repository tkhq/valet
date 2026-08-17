import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEDICATED_INTEGRATION_FILES,
  doctorExitCode,
  renderDoctor,
  truncateOutput,
  INTEGRATION_LIST_FILES,
  missingNeeds,
  needHint,
  parseEnvFile,
  partitionWaves,
  renderScorecard,
  selectSteps,
  toJsonReport,
  STEPS,
  type DoctorCheck,
  type Probes,
  type StepResult,
} from "./lib.js";

const ALL_TRUE: Probes = {
  key: true,
  docker: true,
  helm: true,
  k8sContext: true,
  e2eK8sOptIn: true,
  telegram: true,
  githubLive: true,
  openai: true,
};

describe("STEPS", () => {
  it("has the spec's 34 unique rows", () => {
    expect(STEPS).toHaveLength(34);
    expect(new Set(STEPS.map((s) => s.id)).size).toBe(34);
  });

  it("includes every spec row id", () => {
    const ids = STEPS.map((s) => s.id);
    for (const id of [
      "typecheck", "conventions", "docs-lint", "unit", "engine-unit", "workflow-unit", "gateway-unit",
      "plugins-unit", "sandbox-local", "sandbox-k8s-unit",
      "store-postgres-unit", "web-build", "api-bundle", "helm-golden",
      "sandbox-docker-unit", "registry-drift",
      "integration-core",
      "orchestrator-smoke", "session-smoke", "integration-agent", "cli",
      "sandbox-docker", "sandbox-dind", "sandbox-k8s", "store-postgres", "workspace-prep-docker",
      "prebuilds-docker", "k8s-builder-cluster", "keycloak-oidc",
      "fullstack-docker", "fullstack-k8s", "telegram", "github-live", "openai",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("never sets CI in step env", () => {
    for (const s of STEPS) expect(Object.keys(s.env ?? {})).not.toContain("CI");
  });

  // vitest silently drops every argument after a bare "--" and runs the FULL
  // suite. A step that means to run 2 files instead reruns all ~180. Guard
  // the whole table: no command may contain "--", including inside bash -c
  // strings ("pnpm ... test -- <files>").
  it("no step command smuggles args past a bare -- separator", () => {
    for (const s of STEPS) {
      // Case 1: "--" as its own argv element (the direct-spawn / apiTest
      // case). Element equality, so "--filter"/"--exclude" don't match.
      expect(s.command, s.id).not.toContain("--");
      // Case 2: " -- " inside a test-running arg — the `bash -c "…"` case.
      // Scoped to vitest/pnpm-test invocations so an unrelated command's
      // legitimate `-- <pathspec>` (git's, e.g. registry-drift's
      // `git diff --quiet -- "$f"`) is not flagged. Catches every test
      // command word: `pnpm … test -- foo`, `vitest -- foo`, `run test -- foo`.
      for (const part of s.command) {
        const isTestCmd = /\bvitest\b|\btest\b/.test(part);
        if (isTestCmd) expect(part, `${s.id}: ${part}`).not.toContain(" -- ");
      }
    }
  });

  it("plugins-unit filter list matches the plugin packages that have tests", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const pkgs = join(root, "packages");
    const withTests: string[] = [];
    for (const dir of readdirSync(pkgs)) {
      if (!dir.startsWith("plugin-")) continue;
      const hasTest = ["src", "test"].some((sub) => {
        const p = join(pkgs, dir, sub);
        if (!existsSync(p)) return false;
        const walk = (d: string): boolean =>
          readdirSync(d, { withFileTypes: true }).some((e) =>
            e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".test.ts"),
          );
        return walk(p);
      });
      if (hasTest) {
        const pkgJson = JSON.parse(readFileSync(join(pkgs, dir, "package.json"), "utf8")) as {
          name: string;
        };
        withTests.push(pkgJson.name);
      }
    }
    const step = STEPS.find((s) => s.id === "plugins-unit");
    if (!step) throw new Error("plugins-unit step missing");
    const filters = step.command.filter((_, i) => step.command[i - 1] === "--filter").sort();
    expect(filters).toEqual(withTests.sort());
  });
});

describe("partitionWaves", () => {
  it("splits steps into pre-serial, parallel, and serial waves preserving order", () => {
    const waves = partitionWaves(STEPS);
    // Steps that write files other steps read run alone, first: typecheck
    // (tsc --build re-emits shared/sdk dist) and registry-drift (temporarily
    // rewrites a tracked source file).
    expect(waves.pre.map((s) => s.id)).toEqual(["typecheck", "registry-drift"]);
    // Every parallel step is static-group and flagged parallelSafe.
    for (const s of waves.parallel) {
      expect(s.group, s.id).toBe("static");
      expect(s.parallelSafe, s.id).toBe(true);
    }
    expect(waves.parallel.map((s) => s.id)).toContain("unit");
    expect(waves.parallel.map((s) => s.id)).toContain("plugins-unit");
    expect(waves.parallel.map((s) => s.id)).toContain("web-build");
    // Everything with daemons, ports, keys, or clusters stays serial, in
    // table order.
    const serialIds = waves.serial.map((s) => s.id);
    expect(serialIds).toContain("integration-agent");
    expect(serialIds).toContain("store-postgres");
    expect(serialIds).toContain("fullstack-docker");
    expect(serialIds).not.toContain("unit");
    // The three waves cover every step exactly once.
    const all = [...waves.pre, ...waves.parallel, ...waves.serial].map((s) => s.id).sort();
    expect(all).toEqual(STEPS.map((s) => s.id).sort());
  });

  it("non-static steps are never parallelSafe", () => {
    for (const s of STEPS) {
      if (s.group !== "static") expect(s.parallelSafe, s.id).toBeUndefined();
    }
  });
});

describe("missingNeeds", () => {
  it("is empty when all probes pass", () => {
    for (const s of STEPS) expect(missingNeeds(s, ALL_TRUE)).toEqual([]);
  });

  it("reports each unsatisfied need", () => {
    const fk = STEPS.find((s) => s.id === "fullstack-k8s");
    if (!fk) throw new Error("fullstack-k8s missing");
    expect(missingNeeds(fk, { ...ALL_TRUE, e2eK8sOptIn: false, key: false })).toEqual([
      "key",
      "e2eK8sOptIn",
    ]);
  });
});

describe("needHint", () => {
  it("names the exact fix", () => {
    expect(needHint("key")).toBe("set ANTHROPIC_API_KEY");
    expect(needHint("telegram")).toContain("TELEGRAM_TEST_BOT_TOKEN");
    expect(needHint("e2eK8sOptIn")).toBe("set VALET_E2E_K8S=1");
  });
});

describe("integration file lists", () => {
  it("core + agent + dedicated rows cover every file in src/integration", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const dir = join(root, "packages/api/src/integration");
    const actual = readdirSync(dir)
      .filter((f) => f.endsWith(".test.ts"))
      .map((f) => `src/integration/${f}`)
      .sort();
    const covered = [
      ...new Set([
        ...INTEGRATION_LIST_FILES.core,
        ...INTEGRATION_LIST_FILES.agent,
        ...DEDICATED_INTEGRATION_FILES,
      ]),
    ].sort();
    // A new integration test file MUST be added to a list (or get its own
    // row) — otherwise its key-gated suites would never run in any row.
    expect(covered).toEqual(actual);
  });

  it("core and agent lists don't overlap each other", () => {
    const overlap = INTEGRATION_LIST_FILES.core.filter((f) =>
      INTEGRATION_LIST_FILES.agent.includes(f),
    );
    expect(overlap).toEqual([]);
  });
});

describe("parseEnvFile", () => {
  it("parses values, comments, blanks, and quotes", () => {
    expect(parseEnvFile('# tier\nA=1\n\nB="two"\nC=\'three\'\nD=a=b\n')).toEqual({
      A: "1",
      B: "two",
      C: "three",
      D: "a=b",
    });
  });

  it("throws on malformed lines", () => {
    expect(() => parseEnvFile("NOVALUE\n")).toThrow(/line 1/);
    expect(() => parseEnvFile("=x\n")).toThrow(/line 1/);
  });

  it("accepts the shell-profile paste form (export KEY=VALUE, CRLF)", () => {
    expect(parseEnvFile("export A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
  });

  it("throws on keys containing whitespace instead of silently mis-keying", () => {
    expect(() => parseEnvFile("SOME KEY=1\n")).toThrow(/whitespace/);
  });

  it("strips trailing inline comments from unquoted values only", () => {
    expect(parseEnvFile('A=v1  # note\nB="v2  # kept"\n')).toEqual({ A: "v1", B: "v2  # kept" });
  });
});

describe("scorecard", () => {
  const results: StepResult[] = [
    { id: "typecheck", status: "passed", durationMs: 12_300 },
    { id: "session-smoke", status: "skipped", durationMs: 0, skipReason: "set ANTHROPIC_API_KEY" },
    { id: "unit", status: "failed", durationMs: 5_000 },
  ];

  it("renders one line per step with icons and totals", () => {
    const out = renderScorecard(results);
    expect(out).toContain("✓ typecheck");
    expect(out).toContain("passed (12.3s)");
    expect(out).toContain("⊘ session-smoke");
    expect(out).toContain("skipped — set ANTHROPIC_API_KEY");
    expect(out).toContain("✗ unit");
    expect(out).toContain("1 passed · 1 failed · 1 skipped");
  });

  it("toJsonReport: exit 1 iff a step failed", () => {
    expect(toJsonReport(results).exitCode).toBe(1);
    expect(toJsonReport(results.filter((r) => r.status !== "failed")).exitCode).toBe(0);
    const rep = toJsonReport(results);
    expect(rep.passed).toBe(1);
    expect(rep.failed).toBe(1);
    expect(rep.skipped).toBe(1);
  });
});

describe("doctor", () => {
  const checks: DoctorCheck[] = [
    { id: "node", label: "Node >= 22", ok: true, required: true, detail: "v22.1.0" },
    { id: "sdk", label: "@valet/sdk built", ok: false, required: true, hint: "run `pnpm --filter @valet/sdk build`" },
    { id: "key", label: "Anthropic key", ok: false, required: false, hint: "set ANTHROPIC_API_KEY" },
  ];

  it("renders ✓ with detail, ✗ for required misses, ⊘ for optional ones", () => {
    const out = renderDoctor(checks, 15, 33);
    expect(out).toContain("✓ Node >= 22 — v22.1.0");
    expect(out).toContain("✗ @valet/sdk built — run `pnpm --filter @valet/sdk build`");
    expect(out).toContain("⊘ Anthropic key — set ANTHROPIC_API_KEY");
    expect(out).toContain("1 required check(s) failing");
  });

  it("reports ready + armed count when all required checks pass", () => {
    const ready = checks.filter((c) => c.id !== "sdk");
    const out = renderDoctor(ready, 15, 33);
    expect(out).toContain("ready — 15/33 steps armed");
  });

  it("doctorExitCode: 1 only for required failures", () => {
    expect(doctorExitCode(checks)).toBe(1);
    expect(doctorExitCode(checks.filter((c) => c.id !== "sdk"))).toBe(0);
  });
});

describe("truncateOutput", () => {
  it("passes short output through untouched", () => {
    expect(truncateOutput("a\nb\nc")).toBe("a\nb\nc");
  });

  it("keeps only the tail of long output with a truncation note", () => {
    const long = Array.from({ length: 500 }, (_, i) => `line${i}`).join("\n");
    const out = truncateOutput(long, 100);
    expect(out).toContain("400 lines truncated");
    expect(out).toContain("line499");
    expect(out).not.toContain("line10\n");
  });
});

describe("selectSteps", () => {
  it("filters to the requested ids", () => {
    const picked = selectSteps(STEPS, ["cli", "typecheck"]);
    expect(picked.map((s) => s.id)).toEqual(["typecheck", "cli"]);
  });

  it("returns all steps without --only", () => {
    expect(selectSteps(STEPS)).toHaveLength(34);
  });

  it("throws on unknown ids", () => {
    expect(() => selectSteps(STEPS, ["nope"])).toThrow(/unknown step "nope"/);
  });
});
