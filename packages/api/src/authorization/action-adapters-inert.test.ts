import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../..");
const livePaths = [
  "packages/engine/src/plugin-catalog.ts",
  "packages/engine/src/tool-bridge.ts",
  "packages/api/src/plugins/action-invoker.ts",
  "packages/api/src/workflows/engine-deps.ts",
  "packages/api/src/workflows/permissions.ts",
];

describe("PR 8 adapters stay inert", () => {
  it.each(livePaths)("does not wire canonical authorization in %s", (path) => {
    const source = readFileSync(resolve(root, path), "utf8");
    expect(source).not.toMatch(/adaptInteractiveAction|adaptWorkflowAction|authorizationServicePolicyResolver|AuthorizationService/);
  });
});
