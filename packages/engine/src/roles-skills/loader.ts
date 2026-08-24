import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { TSchema } from "typebox";
import type { RoleSpec, SkillResource, SkillSource } from "../types.js";
import { parseMarkdownArtifact, type FrontmatterValue } from "./parser.js";
import { validateSkillFrontmatter } from "./spec.js";

/**
 * Build a RoleSpec from a markdown blob. Frontmatter keys honored:
 *   name (required)
 *   description (optional)
 *   model (optional — string id, applied when this role is selected for a prompt)
 *
 * Roles are a Valet concept, not an Agent Skills concept, so the skill
 * spec's rules do not apply here.
 */
export function loadRoleFromMarkdown(
  content: string,
  source: RoleSpec["source"] = "session",
  fallbackName?: string,
): RoleSpec {
  const parsed = parseMarkdownArtifact(content);
  const name = String(parsed.frontmatter.name ?? fallbackName ?? "");
  if (!name) {
    throw new Error(
      "loadRoleFromMarkdown: frontmatter.name is required (or pass fallbackName).",
    );
  }
  const description = parsed.frontmatter.description;
  const model = parsed.frontmatter.model;
  return {
    name,
    description: typeof description === "string" ? description : undefined,
    model: typeof model === "string" ? model : undefined,
    content: parsed.body.trimStart(),
    source,
  };
}

/**
 * Build a SkillSource from a `SKILL.md` blob, and enforce the Agent Skills
 * spec (https://agentskills.io/specification) on its frontmatter.
 *
 * `directoryName` is the name of the directory that holds the file. It
 * supplies `name` when the frontmatter omits it, and it is the target of
 * the spec's name-matches-directory rule. Omit it when the directory name
 * is unknown; the rule is then not checked.
 *
 * This THROWS on a violation. Every caller today is a plugin module that
 * loads a skill we ship, so a violation is a build-time bug and must be
 * loud. Code that reads an UNTRUSTED skill must call
 * `validateSkillFrontmatter` first and skip the skills that fail, so one
 * malformed third-party skill cannot stop the process.
 *
 * `argsSchema` is supplied by the caller. It is a Valet extension, not a
 * spec field, so markdown frontmatter is the wrong place for it.
 */
export function loadSkillFromMarkdown(
  content: string,
  source: SkillSource["source"] = "plugin",
  directoryName?: string,
  argsSchema?: TSchema,
): SkillSource {
  const parsed = parseMarkdownArtifact(content);
  const frontmatter: Record<string, FrontmatterValue> = {
    ...parsed.frontmatter,
    name: parsed.frontmatter.name ?? directoryName ?? "",
  };

  const violations = validateSkillFrontmatter(frontmatter, { directoryName });
  if (violations.length > 0) {
    const detail = violations.map((v) => `  - ${v.message}`).join("\n");
    const where = directoryName ? ` in skill "${directoryName}"` : "";
    throw new Error(`SKILL.md frontmatter does not follow the skill spec${where}:\n${detail}`);
  }

  const invocation = frontmatter.invocation;
  return {
    name: String(frontmatter.name),
    description: asString(frontmatter.description),
    argsSchema,
    content: parsed.body.trimStart(),
    source,
    license: asString(frontmatter.license),
    compatibility: asString(frontmatter.compatibility),
    metadata: asStringMap(frontmatter.metadata),
    allowedTools: asString(frontmatter["allowed-tools"]),
    // The validator has already rejected any other value.
    invocation: invocation === "prompt" ? "prompt" : invocation === "context" ? "context" : undefined,
    argHint: asString(frontmatter.argHint),
  };
}

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

function asString(value: FrontmatterValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The validator has already rejected a non-text value, so anything that
 * reaches here is a map of text. */
function asStringMap(value: FrontmatterValue | undefined): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}
