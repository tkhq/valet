import { describe, expect, it } from "vitest";
import plugin from "./plugin.js";

// Importing the manifest exercises loadSkillFromMarkdown's frontmatter
// validation (it throws on a spec violation), so this test fails loudly
// when the markdown drifts from the skill spec.
describe("plugin manifest", () => {
  it("exposes the runner skill and one role per bundled persona", () => {
    expect(plugin.name).toBe("security");
    expect(plugin.skills?.map((s) => s.name)).toEqual(["security-engagement-runner"]);
    // One RoleSpec per bundled persona: code-review, the M-P2b triad roles, and
    // the M-P2c model personas.
    expect(plugin.roles?.map((r) => r.name)).toEqual([
      "code-review",
      "architect",
      "verifier",
      "threat-model",
      "attack-tree",
      "sast",
      "report",
      "dast",
      "fuzz",
      "exploit",
    ]);
  });

  it("loads the architect and verifier role contracts (M-P2b)", () => {
    const architect = plugin.roles?.find((r) => r.name === "architect");
    expect(architect?.content).toContain("You are the ARCHITECT");
    expect(architect?.content).toContain("do not report findings");
    const verifier = plugin.roles?.find((r) => r.name === "verifier");
    expect(verifier?.content).toContain("You are the VERIFIER");
    expect(verifier?.content).toContain("do not trust prior artifacts");
    expect(verifier?.content).toContain("PASS");
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
