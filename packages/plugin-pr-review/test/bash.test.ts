import { describe, expect, it } from "vitest";
import { outsideRepoReason } from "../src/bash.js";

const ws = "/tmp/checkout";

describe("outsideRepoReason", () => {
  it("allows relative paths, the workspace itself, and /dev/null", () => {
    expect(outsideRepoReason("rg -n foo src/ | head", ws)).toBeUndefined();
    expect(outsideRepoReason("cd services && grep -rn x . 2>/dev/null", ws)).toBeUndefined();
    expect(outsideRepoReason(`sed -n 1,20p ${ws}/a.py`, ws)).toBeUndefined();
    expect(outsideRepoReason("git diff abc def -- a.py", ws)).toBeUndefined();
    expect(outsideRepoReason('grep -rn "/api/" .', ws)).toBeUndefined();
    expect(outsideRepoReason("sed -n '/foo/,/bar/p' a.py", ws)).toBeUndefined();
  });

  it("refuses the filesystem root, other absolute paths, and home", () => {
    expect(outsideRepoReason('cd /; grep -rn "x" --include=*.java .', ws)).toMatch(/`\/`/);
    expect(outsideRepoReason("cat /etc/passwd", ws)).toMatch(/\/etc\/passwd/);
    expect(outsideRepoReason("ls ~/.ssh", ws)).toMatch(/~\/\.ssh/);
    expect(outsideRepoReason(`cat ${ws}-other/x`, ws)).toBeDefined();
  });
});
