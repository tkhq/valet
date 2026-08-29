/**
 * Dynamic-config M-F1 + repo-persona roles M-P2c: the host attaches ONLY the
 * role matching a claimed cell's persona, not every security role.
 * `securityRolesForCell` is the pure seam both build paths (post-restart
 * rebuild + first child build) call.
 */
import { describe, expect, it, vi } from "vitest";
import { securityRolesForCell } from "./host.js";

describe("securityRolesForCell", () => {
  it("returns exactly the role matching a bundled persona", () => {
    const roles = securityRolesForCell("code-review");
    expect(roles.map((r) => r.name)).toEqual(["code-review"]);
  });

  it("attaches the architect role for an architect cell (M-P2b)", () => {
    const roles = securityRolesForCell("architect");
    expect(roles.map((r) => r.name)).toEqual(["architect"]);
    expect(roles[0]?.content).toContain("You are the ARCHITECT");
  });

  it("attaches the verifier role for a verifier cell (M-P2b)", () => {
    const roles = securityRolesForCell("verifier");
    expect(roles.map((r) => r.name)).toEqual(["verifier"]);
    expect(roles[0]?.content).toContain("You are the VERIFIER");
  });

  it("attaches the model persona roles for their cells (M-P2c)", () => {
    expect(securityRolesForCell("threat-model").map((r) => r.name)).toEqual(["threat-model"]);
    expect(securityRolesForCell("threat-model")[0]?.content).toContain("THREAT-MODEL");
    expect(securityRolesForCell("attack-tree").map((r) => r.name)).toEqual(["attack-tree"]);
    expect(securityRolesForCell("attack-tree")[0]?.content).toContain("ATTACK-TREE");
    expect(securityRolesForCell("sast").map((r) => r.name)).toEqual(["sast"]);
    expect(securityRolesForCell("sast")[0]?.content).toContain("SAST");
  });

  it("loads a repo-defined persona's role from its markdown, repo wins (M-P2c)", () => {
    const md = [
      "---",
      "name: my-persona",
      "description: A repo-defined persona.",
      "---",
      "",
      "You are the CUSTOM repo persona. Do the special sweep.",
    ].join("\n");
    const roles = securityRolesForCell("my-persona", md);
    // The role name is forced to the cell's persona id so the dispatch prompt's
    // `role: cell.persona` overlay resolves, not code-review.
    expect(roles.map((r) => r.name)).toEqual(["my-persona"]);
    expect(roles[0]?.content).toContain("CUSTOM repo persona");
    expect(roles[0]?.source).toBe("session");
  });

  it("forces the role name to the persona id even when the markdown names another (M-P2c)", () => {
    const md = ["---", "name: different-frontmatter-name", "---", "", "Body."].join("\n");
    const roles = securityRolesForCell("cfg-key", md);
    expect(roles.map((r) => r.name)).toEqual(["cfg-key"]);
  });

  it("falls back to code-review for a repo persona with no stashed markdown", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const roles = securityRolesForCell("unknown-repo-persona");
    expect(roles.map((r) => r.name)).toEqual(["code-review"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("falls back to code-review when the repo markdown fails to load", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // No frontmatter name and no usable name → loadRoleFromMarkdown would still
    // accept the persona as fallbackName, so force a genuine failure with an
    // empty body markdown that yields no name. An empty string is skipped; a
    // markdown with only whitespace also skips. Use a blank string here.
    const roles = securityRolesForCell("repo-persona", "   ");
    expect(roles.map((r) => r.name)).toEqual(["code-review"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
