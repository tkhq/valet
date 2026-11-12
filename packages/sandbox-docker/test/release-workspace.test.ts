import { describe, expect, it } from "vitest";
import { releaseWorkspaceArgs } from "../src/index.js";

describe("releaseWorkspaceArgs", () => {
  it("deletes the working directory's contents as the sandbox root, with no network and only delete capabilities", () => {
    const args = releaseWorkspaceArgs("/var/lib/valet/.valet/children/child_1", "valet-sandbox:current", "valet.slice");
    expect(args.slice(0, 4)).toEqual(["run", "--rm", "--cgroup-parent", "valet.slice"]);
    expect(args).toEqual(expect.arrayContaining(["--network", "none", "--user", "0", "--cap-drop", "ALL", "--entrypoint", "find"]));
    expect(args.filter((a) => a.startsWith("--cap-add") || args[args.indexOf(a) - 1] === "--cap-add")).toEqual(["--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER"]);
    expect(args).toEqual(expect.arrayContaining(["-v", "/var/lib/valet/.valet/children/child_1:/workspace"]));
    // The directory itself stays: a revived child is rebuilt in it.
    expect(args.slice(-5)).toEqual(["valet-sandbox:current", "/workspace", "-mindepth", "1", "-delete"]);
  });
});
