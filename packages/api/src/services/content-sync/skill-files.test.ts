import { expect, it, vi } from "vitest";
import type { SkillFile } from "@valet/engine";
import type { SkillRepoReader, SkillTreeEntry } from "../skill-repo-reader.js";
import { indexCompanions, readSkillFiles, MAX_SKILL_FILES, MAX_SKILL_BYTES, MAX_SKILL_FILE_BYTES } from "./skill-files.js";

it("indexes a large tree in a bounded number of entry visits", () => {
  let visits = 0;
  const tree: SkillTreeEntry[] = [];
  for (let i = 0; i < 8000; i++) {
    for (const path of [`skill-${i}/SKILL.md`, `skill-${i}/scripts/check.py`]) {
      tree.push({ get path() { visits++; return path; }, type: "blob", mode: "100644", sha: path, size: 0 });
    }
  }
  expect(indexCompanions(tree).size).toBe(8000);
  // A per-candidate rescan would exceed 100 million visits.
  expect(visits).toBeLessThan(tree.length * 15);
});

it("assigns each blob to the closest regular SKILL.md boundary", () => {
  const entry = (path: string, mode = "100644"): SkillTreeEntry => ({ path, mode, type: "blob", sha: path });
  const groups = indexCompanions([entry("outer/SKILL.md"), entry("outer/scripts/SKILL.md", "120000"),
    entry("outer/scripts/check.py"), entry("outer/inner/SKILL.md"), entry("outer/inner/scripts/nested.py")]);
  expect(groups.get("outer/SKILL.md")?.map(file => file.path)).toEqual(["outer/scripts/check.py"]);
  expect(groups.get("outer/inner/SKILL.md")?.map(file => file.path)).toEqual(["outer/inner/scripts/nested.py"]);
});

it.each(["count", "bytes"])("enforces the %s cap on retained versions and the final deferred set", async cap => {
  const size = cap === "bytes" ? MAX_SKILL_FILE_BYTES : 1;
  const count = cap === "bytes" ? MAX_SKILL_BYTES / size : MAX_SKILL_FILES;
  const previous: SkillFile[] = Array.from({ length: count }, (_, i) => ({ path: `references/${i}.md`, blobSha: `old-${i}`, size, mode: "100644" }));
  const reader: SkillRepoReader = {
    head: vi.fn(), listDirectory: vi.fn(), listTree: vi.fn(),
    readFile: async (_repo, path) => path.endsWith("new.md") ? { text: "", blobSha: "new", bytes: new Uint8Array(size) } : null,
  };
  const entries: SkillTreeEntry[] = [
    { path: "skill/references/new.md", sha: "new", type: "blob", mode: "100644", size },
    ...previous.map(file => ({ path: `skill/${file.path}`, sha: "changed", type: "blob", mode: file.mode, size: 1 })),
  ];
  const result = await readSkillFiles(reader, "a/b", "sha", "skill/SKILL.md", entries, previous, new Map());
  expect(result.deferred).toBe(true);
  expect(result.files.some(file => file.path === "references/new.md")).toBe(true);
  expect(result.files.length).toBeLessThanOrEqual(MAX_SKILL_FILES);
  expect(result.files.reduce((sum, file) => sum + file.size, 0)).toBeLessThanOrEqual(MAX_SKILL_BYTES);
  expect(result.warning).toContain("companion caps");
});
