import { describe, expect, it } from "vitest";
import plugin from "./plugin.js";

// Importing the manifest exercises loadSkillFromMarkdown's frontmatter
// validation (it throws on a spec violation), so this test fails loudly
// when the markdown drifts from the skill spec.
describe("plugin manifest", () => {
  it("exposes the runner skill and the code-review role", () => {
    expect(plugin.name).toBe("security");
    expect(plugin.skills?.map((s) => s.name)).toEqual(["security-engagement-runner"]);
    expect(plugin.roles?.map((r) => r.name)).toEqual(["code-review"]);
  });

  it("carries the runner's first rule and the loop", () => {
    const skill = plugin.skills?.[0];
    expect(skill?.content).toContain("Trust `sec_status`, never your conversation memory");
    expect(skill?.content).toContain("sec_cell_complete");
    expect(skill?.content).toContain("sec_close");
  });

  it("carries the persona's exit condition and prohibitions", () => {
    const role = plugin.roles?.[0];
    expect(role?.source).toBe("plugin");
    expect(role?.content).toContain("`checklist.pending` and `queue.pending` are both 0");
    expect(role?.content).toContain("Editing files");
    expect(role?.content).toContain("gitleaks");
  });

  it("tells the persona to verify known invariants (M-F3)", () => {
    const role = plugin.roles?.[0];
    expect(role?.content).toContain("known invariants");
    expect(role?.content).toContain("A confirmed violation is a finding; cite the invariant.");
    expect(role?.content).toContain("Do not assume an invariant holds just because it is asserted.");
  });
});
