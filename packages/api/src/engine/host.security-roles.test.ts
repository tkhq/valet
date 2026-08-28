/**
 * Dynamic-config M-F1: the host attaches ONLY the role matching a claimed
 * cell's persona, not every security role. `securityRolesForCell` is the pure
 * seam both build paths (post-restart rebuild + first child build) call.
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

  it("falls back to the code-review role for a repo-defined persona (M-F1 TODO)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const roles = securityRolesForCell("threat-model");
    // No bundled role for a repo persona yet; the code-review role is attached
    // and a note is logged.
    expect(roles.map((r) => r.name)).toEqual(["code-review"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
