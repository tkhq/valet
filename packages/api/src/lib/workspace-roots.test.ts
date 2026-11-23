import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientWorkspacePath, clientWorkspaceRoot, isStrictlyInside, workspaceRealpathRefusal } from "./workspace-roots.js";

describe("client working directories", () => {
  it("builds the directory under the caller's own root from the last path segment", () => {
    expect(clientWorkspacePath("/srv/ws", "user-1", "/tmp/valet/workspace/acme-api")).toBe("/srv/ws/user-1/acme-api");
    // The attack request: workspace "/" lands in the caller's directory, not the host root.
    expect(clientWorkspacePath("/srv/ws", "user-1", "/")).toBe("/srv/ws/user-1/workspace");
    expect(clientWorkspacePath("/srv/ws", "user-1", "/a/b/..")).toBe("/srv/ws/user-1/workspace");
    expect(clientWorkspacePath("/srv/ws", "../other", "/x/.hidden")).toBe("/srv/ws/-other/hidden");
  });

  it("refuses a configured root that is the host root or a top-level directory", () => {
    expect(() => clientWorkspaceRoot({ VALET_WORKSPACE_ROOT: "/" })).toThrow(/at least two levels deep/);
    expect(() => clientWorkspaceRoot({ VALET_WORKSPACE_ROOT: "/tmp" })).toThrow(/at least two levels deep/);
    expect(() => clientWorkspaceRoot({ VALET_WORKSPACE_ROOT: "relative/path" })).toThrow(/absolute/);
    expect(clientWorkspaceRoot({ VALET_WORKSPACE_ROOT: "/var/lib/valet/workspaces" })).toBe("/var/lib/valet/workspaces");
  });

  it("treats a directory as never inside itself", () => {
    expect(isStrictlyInside("/srv/ws/u", "/srv/ws/u")).toBe(false);
    expect(isStrictlyInside("/srv/ws/u/a", "/srv/ws/u")).toBe(true);
    expect(isStrictlyInside("/srv/ws/other", "/srv/ws/u")).toBe(false);
  });

  it("refuses a built directory that links out of the caller's directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "valet-ws-roots-"));
    const userDir = join(root, "user-1");
    await mkdir(join(userDir, "real"), { recursive: true });
    await symlink("/", join(userDir, "escape"));
    expect(await workspaceRealpathRefusal(join(userDir, "real"), userDir)).toBeNull();
    expect(await workspaceRealpathRefusal(join(userDir, "escape"), userDir)).toMatch(/outside your working-directory root/);
  });
});
