import { describe, expect, it } from "vitest";
import { hostWorkspaceRefusal } from "../src/host-workspace.js";

const guards = { privatePaths: ["/data/docker-runtime", "/data/pg"], dataRoots: ["/data"] };

describe("hostWorkspaceRefusal", () => {
  it("refuses the host root and top-level directories", () => {
    expect(hostWorkspaceRefusal("/", guards)).toMatch(/host root or a top-level/);
    expect(hostWorkspaceRefusal("/home", guards)).toMatch(/host root or a top-level/);
  });

  it("refuses system trees", () => {
    expect(hostWorkspaceRefusal("/etc/ssh", guards)).toMatch(/\/etc/);
    expect(hostWorkspaceRefusal("/var/lib/containerd/io", guards)).toMatch(/\/var\/lib\/containerd/);
  });

  it("refuses a directory that holds or sits in private state, or holds the data root", () => {
    expect(hostWorkspaceRefusal("/data/docker-runtime/x", guards)).toMatch(/overlaps private/);
    expect(hostWorkspaceRefusal("/data/pg/base", guards)).toMatch(/overlaps private/);
    expect(hostWorkspaceRefusal("/srv/../data", guards)).toMatch(/host root or a top-level|overlaps private/);
  });

  it("allows working directories under the data root and elsewhere", () => {
    expect(hostWorkspaceRefusal("/data/children/s_1", guards)).toBeNull();
    expect(hostWorkspaceRefusal("/var/lib/valet/.valet/children/s_1", guards)).toBeNull();
    expect(hostWorkspaceRefusal("/tmp/valet/workspace/repo", guards)).toBeNull();
  });

  it("refuses a directory outside the allowed roots when the api passes them", () => {
    const allowed = { ...guards, allowedRoots: ["/var/lib/valet/.valet/children", "/data"] };
    expect(hostWorkspaceRefusal("/var/lib/valet/.valet/children/s_1", allowed)).toBeNull();
    expect(hostWorkspaceRefusal("/data/children/s_1", allowed)).toBeNull();
    expect(hostWorkspaceRefusal("/root/.ssh", allowed)).toMatch(/outside Valet's working-directory roots/);
    expect(hostWorkspaceRefusal("/opt/valet/app", allowed)).toMatch(/outside Valet's working-directory roots/);
    expect(hostWorkspaceRefusal("/var/lib/valet/.valet/children", allowed)).toMatch(/outside Valet's working-directory roots/);
  });
});
