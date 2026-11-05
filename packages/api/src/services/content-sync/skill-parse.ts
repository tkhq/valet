/**
 * How content sync reads one `SKILL.md` or `prompts/<name>.md` it found.
 * Pure: no database and no repository reader, so `valet validate` applies
 * the same rules to a local checkout that a sync applies to a commit.
 * `skill-collector.ts` decides what to do with the result.
 */
import {
  BUILTIN_COMMAND_NAMES,
  parseMarkdownArtifact,
  validateSkillFrontmatter,
  type SkillSpecViolation,
} from "@valet/engine";

export interface ParsedSkillFile {
  name: string;
  description: string;
  body: string;
  frontmatter: Record<string, unknown>;
  violations: SkillSpecViolation[];
}

/**
 * Parses one `SKILL.md` and checks it against the spec WITHOUT throwing.
 * `loadSkillFromMarkdown` throws, which is wrong for a third party's
 * repository, so this calls the validator directly.
 */
export function parseSkillFile(raw: string, directoryName: string): ParsedSkillFile {
  const parsed = parseMarkdownArtifact(raw);
  const frontmatter: Record<string, unknown> = {
    ...parsed.frontmatter,
    name: parsed.frontmatter.name ?? directoryName,
  };
  const violations = validateSkillFrontmatter(frontmatter, { directoryName });
  // Reject reserved builtin names so a repo skill cannot shadow a built-in command.
  if ((BUILTIN_COMMAND_NAMES as readonly string[]).includes(directoryName)) {
    violations.push({
      field: "name",
      severity: "error",
      message: `"${directoryName}" is a reserved built-in command name. Rename the skill directory.`,
    });
  }
  return {
    name: typeof frontmatter.name === "string" ? frontmatter.name : directoryName,
    description: typeof frontmatter.description === "string" ? frontmatter.description : "",
    body: parsed.body.trimStart(),
    frontmatter,
    violations,
  };
}

/**
 * Parses one `prompts/<name>.md`. It differs from `SKILL.md`: `name` is the
 * filename stem and never a frontmatter field; `invocation` defaults to
 * `"prompt"` and takes only `"context"` beside it, any other value being an
 * error that skips the file; and `description` is optional.
 */
export function parsePromptFile(raw: string, fileName: string): ParsedSkillFile {
  const parsed = parseMarkdownArtifact(raw);

  // Prompts may omit `description`, so that violation is dropped.
  const nameViolations = validateSkillFrontmatter(
    { name: fileName, description: "placeholder" },
    { directoryName: fileName },
  ).filter((v) => v.field !== "description");

  if ((BUILTIN_COMMAND_NAMES as readonly string[]).includes(fileName)) {
    nameViolations.push({
      field: "name",
      severity: "error",
      message: `"${fileName}" is a reserved built-in command name. Rename the file.`,
    });
  }

  const rawInvocation = parsed.frontmatter.invocation;
  const invocationViolations: SkillSpecViolation[] = [];
  let invocation: "prompt" | "context" = "prompt";
  if (rawInvocation === undefined) {
    // Default — no violation.
  } else if (rawInvocation === "prompt" || rawInvocation === "context") {
    invocation = rawInvocation;
  } else {
    invocationViolations.push({
      field: "invocation",
      severity: "error",
      message: `invocation "${String(rawInvocation)}" is not "prompt" or "context". Set invocation to "prompt" or "context".`,
    });
  }

  // Set the resolved `invocation` only when it is valid: an invalid one is
  // skipped anyway, and returning a value it never had misleads the caller.
  const frontmatter: Record<string, unknown> = {
    ...parsed.frontmatter,
    name: fileName,
    ...(invocationViolations.length === 0 ? { invocation } : {}),
  };

  return {
    name: fileName,
    description:
      typeof parsed.frontmatter.description === "string" ? parsed.frontmatter.description : "",
    body: parsed.body.trimStart(),
    frontmatter,
    violations: [...nameViolations, ...invocationViolations],
  };
}
