/**
 * The `workflows` skill must hold the current generated step reference.
 *
 * Agents read the skill before they draft a workflow. The reference lists
 * every field each step type accepts, rendered from the validator's own
 * tables (`@valet/workflow` `renderStepReferenceBlock`). If this test fails,
 * run `pnpm exec tsx scripts/workflows/write-step-reference.mjs`.
 */
import { describe, expect, it } from "vitest";
import { renderStepReferenceBlock } from "@valet/workflow";
import { bundledPlugins } from "../plugins/registry.gen.js";

describe("workflows skill step reference", () => {
  it("holds the reference that the validator's tables render", () => {
    const skill = bundledPlugins.find((plugin) => plugin.name === "workflows")?.skills?.find((entry) => entry.name === "workflows");
    if (!skill) throw new Error('the bundled "workflows" plugin ships no "workflows" skill');
    expect(skill.content).toContain(renderStepReferenceBlock());
  });
});
