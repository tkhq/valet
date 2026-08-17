/**
 * Every skill Valet ships must follow the Agent Skills spec
 * (https://agentskills.io/specification): a `<name>/SKILL.md` directory
 * whose frontmatter `name` equals the directory name.
 *
 * This walks every real plugin package's `skills` directory on disk, plus
 * the real bundled registry, so a new plugin skill in the old flat layout
 * — or one whose name drifts from its directory — fails here rather than
 * at a customer's session start.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMarkdownArtifact, validateSkillFrontmatter } from "@valet/engine";
import { bundledPlugins } from "./registry.gen.js";
import { pluginSessionExtras } from "./assemble.js";

const PACKAGES_DIR = fileURLToPath(new URL("../../../", import.meta.url));

interface SkillOnDisk {
  plugin: string;
  directory: string;
  file: string;
}

/** True when the package's `plugin.yaml` parks it with `enabled: false`.
 * A parked plugin keeps its skill directory on disk but is left out of the
 * generated registry on purpose, so the loaded set cannot be compared
 * against every directory that exists. */
function isParked(pkg: string): boolean {
  try {
    return /^\s*enabled:\s*false\s*$/m.test(
      readFileSync(join(PACKAGES_DIR, pkg, "plugin.yaml"), "utf8"),
    );
  } catch {
    return false; // No manifest: not parked.
  }
}

function skillsOnDisk(): SkillOnDisk[] {
  const found: SkillOnDisk[] = [];
  for (const pkg of readdirSync(PACKAGES_DIR)) {
    if (!pkg.startsWith("plugin-")) continue;
    const skillsDir = join(PACKAGES_DIR, pkg, "skills");
    let entries: string[];
    try {
      entries = readdirSync(skillsDir);
    } catch {
      continue; // Plugin ships no skills.
    }
    for (const entry of entries) {
      const path = join(skillsDir, entry);
      expect(statSync(path).isDirectory(), `${pkg}/skills/${entry} is not a skill directory`).toBe(
        true,
      );
      found.push({ plugin: pkg, directory: entry, file: join(path, "SKILL.md") });
    }
  }
  return found;
}

describe("bundled skills follow the Agent Skills spec", () => {
  const onDisk = skillsOnDisk();

  it("finds every skill as a directory holding a SKILL.md", () => {
    expect(onDisk.length).toBeGreaterThan(0);
    for (const skill of onDisk) {
      expect(statSync(skill.file).isFile(), `${skill.file} is missing`).toBe(true);
    }
  });

  for (const skill of onDisk) {
    it(`${skill.plugin}/${skill.directory} has conforming frontmatter`, () => {
      const parsed = parseMarkdownArtifact(readFileSync(skill.file, "utf8"));
      const violations = validateSkillFrontmatter(parsed.frontmatter, {
        directoryName: skill.directory,
      });
      expect(violations.map((v) => v.message)).toEqual([]);
    });
  }

  it("loads every bundled plugin's skills with unique names", () => {
    const { skills } = pluginSessionExtras(bundledPlugins);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual([...new Set(names)]);
    // Parked plugins keep their skill directory but ship no skill, so the
    // comparison is against the ENABLED set. Comparing against every
    // directory on disk would make parking a plugin fail this test, and
    // parking is a supported state.
    const expected = onDisk
      .filter((s) => !isParked(s.plugin))
      .map((s) => s.directory)
      .sort();
    expect(names).toEqual(expected);
  });
});
