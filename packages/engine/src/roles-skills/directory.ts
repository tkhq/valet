/**
 * Node-only skill-directory loader. This module reads the filesystem, so
 * it lives OUTSIDE the engine barrel: the web bundle reaches the barrel
 * through @valet/sdk, and vite externalizes node builtins to empty
 * modules, which breaks the browser build. Import this via the
 * `@valet/engine/skills-directory` subpath from node-side code only.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { TSchema } from "typebox";
import type { SkillResource, SkillSource } from "../types.js";
import { loadSkillFromMarkdown } from "./loader.js";

/** Caps for one skill's resource bundle. Plugin skills are ours, so an
 * oversized bundle is a build-time bug and must be loud (same posture as
 * `loadSkillFromMarkdown`'s throw-on-violation). */
export const SKILL_RESOURCES_MAX_FILES = 64;
export const SKILL_RESOURCES_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Build a SkillSource from a skill DIRECTORY: `SKILL.md` plus any files
 * beside it (Agent Skills spec: `scripts/`, `references/`, `assets/`, or
 * anything else). The extra files land in `resources` with skill-root-
 * relative paths, and `resourcesHash` fingerprints the bundle for the
 * staged-file prep step (docs/specs/2026-08-23-staged-files-design.md).
 *
 * Loading is eager and synchronous, at plugin module load, the same
 * moment `SKILL.md` is read today. Two caps keep that sane:
 * SKILL_RESOURCES_MAX_FILES files and SKILL_RESOURCES_MAX_BYTES bytes per
 * skill. A skill over a cap throws with the skill named.
 */
export function loadSkillFromDirectory(
  dir: string,
  source: SkillSource["source"] = "plugin",
  argsSchema?: TSchema,
): SkillSource {
  const directoryName = basename(dir);
  const content = readFileSync(join(dir, "SKILL.md"), "utf8");
  const skill = loadSkillFromMarkdown(content, source, directoryName, argsSchema);

  const resources: SkillResource[] = [];
  let totalBytes = 0;
  const walk = (rel: string) => {
    const entries = readdirSync(join(dir, rel), { withFileTypes: true });
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(relPath);
        continue;
      }
      // Symlinks are skipped for the same reason repository sync skips
      // them: the blob behind one is a path string, not the file.
      if (!entry.isFile()) continue;
      if (relPath === "SKILL.md") continue;
      const data = new Uint8Array(readFileSync(join(dir, relPath)));
      totalBytes += data.byteLength;
      resources.push({ path: relPath, data });
      if (resources.length > SKILL_RESOURCES_MAX_FILES) {
        throw new Error(
          `Skill "${directoryName}" ships more than ${SKILL_RESOURCES_MAX_FILES} resource files. ` +
            `Remove files from the skill directory, or load only SKILL.md with loadSkillFromMarkdown.`,
        );
      }
      if (totalBytes > SKILL_RESOURCES_MAX_BYTES) {
        throw new Error(
          `Skill "${directoryName}" ships more than 5 MiB (${SKILL_RESOURCES_MAX_BYTES} bytes) of resources. ` +
            `Shrink the bundle, or load only SKILL.md with loadSkillFromMarkdown.`,
        );
      }
    }
  };
  walk("");

  if (resources.length === 0) return skill;
  resources.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash("sha256");
  for (const resource of resources) {
    hash.update(resource.path);
    hash.update("\0");
    hash.update(String(resource.data.byteLength));
    hash.update("\0");
    hash.update(resource.data);
  }
  return { ...skill, resources, resourcesHash: hash.digest("hex") };
}
