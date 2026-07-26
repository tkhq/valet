import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  missingNeeds,
  needHint,
  parseEnvFile,
  renderScorecard,
  selectSteps,
  toJsonReport,
  STEPS,
  type Probes,
  type StepResult,
} from "./lib.js";

const ALL_TRUE: Probes = {
  key: true,
  docker: true,
  k8sContext: true,
  e2eK8sOptIn: true,
  telegram: true,
  githubLive: true,
  openai: true,
};

describe("STEPS", () => {
  it("has the spec's 25 unique rows", () => {
    expect(STEPS).toHaveLength(25);
    expect(new Set(STEPS.map((s) => s.id)).size).toBe(25);
  });

  it("includes every spec row id", () => {
    const ids = STEPS.map((s) => s.id);
    for (const id of [
      "typecheck", "unit", "engine-unit", "workflow-unit", "gateway-unit",
      "runner-unit", "plugins-unit", "sandbox-local", "integration-core",
      "orchestrator-smoke", "session-smoke", "integration-agent", "cli",
      "sandbox-docker", "sandbox-k8s", "store-postgres", "workspace-prep-docker",
      "prebuilds-docker", "k8s-builder-cluster", "keycloak-oidc",
      "fullstack-docker", "fullstack-k8s", "telegram", "github-live", "openai",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("never sets CI in step env", () => {
    for (const s of STEPS) expect(Object.keys(s.env ?? {})).not.toContain("CI");
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

describe("selectSteps", () => {
  it("filters to the requested ids", () => {
    const picked = selectSteps(STEPS, ["cli", "typecheck"]);
    expect(picked.map((s) => s.id)).toEqual(["typecheck", "cli"]);
  });

  it("returns all steps without --only", () => {
    expect(selectSteps(STEPS)).toHaveLength(25);
  });

  it("throws on unknown ids", () => {
    expect(() => selectSteps(STEPS, ["nope"])).toThrow(/unknown step "nope"/);
  });
});
