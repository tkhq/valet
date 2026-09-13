import { readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../..");
const roots = [
  "packages/engine/src/engine.ts", "packages/engine/src/session.ts", "packages/engine/src/thread.ts", "packages/engine/src/tool-bridge.ts", "packages/engine/src/plugin-catalog.ts", "packages/engine/src/index.ts",
  "packages/api/src/engine", "packages/api/src/plugins/action-invoker.ts", "packages/api/src/workflows",
];
const seam = /action-adapters|action-plans|plugin-catalog-authorization|action-invoker-authorization|adaptInteractiveAction|adaptWorkflowAction|authorizationServicePolicyResolver|AuthorizationService/;

function productionFiles(path: string): string[] {
  const absolute = resolve(root, path);
  if (extname(absolute) === ".ts") return [absolute];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? productionFiles(join(path, entry.name)) : entry.name.endsWith(".ts") && !entry.name.includes(".test.") ? [join(absolute, entry.name)] : []);
}

describe("PR 8 adapters stay inert", () => {
  it.each(roots.flatMap(productionFiles))("does not import or alias the seam in %s", (path) => {
    expect(readFileSync(path, "utf8")).not.toMatch(seam);
  });
});
