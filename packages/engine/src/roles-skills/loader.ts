import type { TSchema } from "typebox";
import type { RoleSpec, SkillSource } from "../types.js";
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

/**
 * The note appended when a resource-bearing skill's body is delivered
 * WITHOUT going through the `skill` tool (slash-command expansion,
 * `Thread.skill()`). Only the tool materializes bundled files into the
 * sandbox, so those paths must tell the model how to get them
 * (staged-files design, 2026-08-23). Empty for a skill with no resources.
 */
export function skillResourceNote(skill: Pick<SkillSource, "name" | "resources">): string {
  if (!skill.resources || skill.resources.length === 0) return "";
  return (
    `\n\nThis skill ships bundled files (scripts/, references/, assets/). ` +
    `Call the \`skill\` tool with name "${skill.name}" before you use them — ` +
    `it writes the files into the workspace and reports where they are.`
  );
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
