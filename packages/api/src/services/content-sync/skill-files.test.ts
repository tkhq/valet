import { expect, it } from "vitest";
import type { SkillTreeEntry } from "../skill-repo-reader.js";
import { indexCompanions } from "./skill-files.js";

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
