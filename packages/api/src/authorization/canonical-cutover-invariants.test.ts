import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../..");
const productionRoots = ["packages/engine/src", "packages/api/src", "packages/workflow/src"];
const legacy = /resolveActionPolicy|resolvePolicyDecision|buildPolicyResolver|orgPolicyWinner|validateOverrideBounds\(db|policies\/resolution/;

function productionFiles(path: string): string[] {
  const absolute = resolve(root, path);
  if (extname(absolute) === ".ts") return [absolute];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? productionFiles(join(path, entry.name))
    : entry.name.endsWith(".ts") && !entry.name.includes(".test.") ? [join(absolute, entry.name)] : []);
}

describe("PR 9 canonical authorization cutover", () => {
  it("has no legacy evaluator implementation or production reference", () => {
    expect(existsSync(resolve(root, "packages/api/src/policies/resolution.ts"))).toBe(false);
    for (const path of productionRoots.flatMap(productionFiles)) expect(readFileSync(path, "utf8"), path).not.toMatch(legacy);
  });

  it("keeps policy routes and workflow analysis on canonical services", () => {
    const preview = readFileSync(resolve(root, "packages/api/src/routes/policies.ts"), "utf8");
    const workflow = readFileSync(resolve(root, "packages/api/src/workflows/permissions.ts"), "utf8");
    expect(preview).toContain("canonicalAuthorizationService.preview(");
    expect(workflow).toContain("service.preview(");
    expect(preview).not.toContain("canonicalAuthorizationService.authorize(");
    expect(workflow).not.toMatch(/\.authorize\(/);
  });

  it("limits static policy table writes to transaction callback helpers", () => {
    const allowedWriters = new Set([
      "packages/api/src/policies/admin.ts",
      "packages/api/src/policies/service.ts",
      "packages/api/src/services/config-reconcile.ts",
      "packages/api/src/services/teams.ts",
    ].map((path) => resolve(root, path)));
    const mutation = /(?:insert|update|delete)\(actionPolic(?:ies|yOverrides)\)/;
    for (const path of productionFiles("packages/api/src")) {
      if (mutation.test(readFileSync(path, "utf8"))) expect(allowedWriters.has(path), path).toBe(true);
    }

    const managerWiring = [
      ["packages/api/src/routes/policies.ts", "canonicalPolicyManager.mutateAndActivate("],
      ["packages/api/src/routes/me-policies.ts", "canonicalPolicyManager.mutateAndActivate("],
      ["packages/api/src/routes/team-policies.ts", "canonicalPolicyManager.mutateAndActivate("],
      ["packages/api/src/services/config-reconcile.ts", "manager.mutateAndActivate("],
      ["packages/api/src/services/team-resource-deletion.ts", "manager.mutateAndActivate("],
      ["packages/api/src/authorization/canonical-interactive-resolver.ts", "service.mutateAndActivate("],
      ["packages/api/src/workflows/service.ts", "canonicalPolicyManager.mutateAndActivate("],
      ["packages/api/src/workflows/permissions.ts", "manager.mutateAndActivate("],
    ] as const;
    for (const [path, call] of managerWiring) expect(readFileSync(resolve(root, path), "utf8"), path).toContain(call);
  });
});
