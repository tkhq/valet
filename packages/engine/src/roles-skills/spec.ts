/**
 * Agent Skills frontmatter validation — https://agentskills.io/specification.
 *
 * Pure and I/O-free: it takes already-parsed frontmatter and returns the
 * violations it found. The name-matches-directory rule needs the directory
 * name as an input, because this module never touches the file system.
 *
 * It RETURNS violations rather than throwing. Callers decide how loud a
 * violation is: `loadSkillFromMarkdown` throws for the skills we ship (a
 * build-time bug), while an importer reading a third-party repository can
 * report the violations and skip that one skill.
 */

export type SkillSpecField =
  | "name"
  | "description"
  | "license"
  | "compatibility"
  | "metadata"
  | "allowed-tools";

export interface SkillSpecViolation {
  field: SkillSpecField;
  /** States what is wrong, then what to do about it. */
  message: string;
}

export interface SkillSpecOptions {
  /** Name of the directory that holds this `SKILL.md`. When given, the
   * `name` field must equal it (the spec's name-matches-directory rule). */
  directoryName?: string;
}

const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const COMPATIBILITY_MAX = 500;

/** Lowercase letters, digits, and hyphens only. */
const NAME_CHARSET = /^[a-z0-9-]+$/;

/**
 * A description that is nothing but a YAML block scalar header (`|-`, `>`,
 * `|2`, …). The reader kept the header and dropped the lines under it, so
 * the description is gone. Every turn pays for the description and the
 * model uses it to choose a skill, so this must be loud rather than a
 * skill nobody can find. It cannot reject a real description: a header is
 * at most three characters and carries no information.
 */
const BLOCK_SCALAR_ONLY = /^[|>][0-9+-]{0,2}$/;

/**
 * Checks parsed skill frontmatter against the spec. An empty array means
 * the frontmatter conforms. At most one violation is reported per field —
 * the first rule that field breaks.
 */
export function validateSkillFrontmatter(
  frontmatter: Record<string, unknown>,
  opts: SkillSpecOptions = {},
): SkillSpecViolation[] {
  const violations: SkillSpecViolation[] = [];

  const nameViolation = checkName(frontmatter.name, opts.directoryName);
  if (nameViolation) violations.push({ field: "name", message: nameViolation });

  const descriptionViolation = checkDescription(frontmatter.description);
  if (descriptionViolation) violations.push({ field: "description", message: descriptionViolation });

  if (frontmatter.license !== undefined && typeof frontmatter.license !== "string") {
    violations.push({
      field: "license",
      message: 'license is not text. Write a license name, or the name of a bundled license file.',
    });
  }

  const compatibility = frontmatter.compatibility;
  if (compatibility !== undefined) {
    if (typeof compatibility !== "string") {
      violations.push({
        field: "compatibility",
        message: "compatibility is not text. Write the environment requirements as one line of text.",
      });
    } else if (compatibility.length > COMPATIBILITY_MAX) {
      violations.push({
        field: "compatibility",
        message: `compatibility is longer than ${COMPATIBILITY_MAX} characters. Shorten it to ${COMPATIBILITY_MAX} characters or fewer.`,
      });
    }
  }

  if (frontmatter.metadata !== undefined && !isStringMap(frontmatter.metadata)) {
    violations.push({
      field: "metadata",
      message:
        "metadata is not a map of text values. Quote every value so each key maps to text.",
    });
  }

  const allowedTools = frontmatter["allowed-tools"];
  if (allowedTools !== undefined && typeof allowedTools !== "string") {
    violations.push({
      field: "allowed-tools",
      message:
        "allowed-tools is not text. Write the tool names as one space-separated line of text.",
    });
  }

  return violations;
}

function checkName(value: unknown, directoryName?: string): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return 'name is required. Add a "name" field that matches the skill directory name.';
  }
  if (value.length > NAME_MAX) {
    return `name is longer than ${NAME_MAX} characters. Shorten it to ${NAME_MAX} characters or fewer.`;
  }
  if (!NAME_CHARSET.test(value)) {
    return 'name has characters that are not lowercase letters, numbers, or hyphens. Use only "a-z", "0-9", and "-".';
  }
  if (value.startsWith("-") || value.endsWith("-")) {
    return "name starts or ends with a hyphen. Remove the hyphen from the start and the end.";
  }
  if (value.includes("--")) {
    return "name has consecutive hyphens. Use one hyphen between words.";
  }
  if (directoryName !== undefined && value !== directoryName) {
    return `name "${value}" does not match the directory name "${directoryName}". Rename the directory, or change the name field so the two agree.`;
  }
  return null;
}

function checkDescription(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "description is required. Write what the skill does and when to use it.";
  }
  if (BLOCK_SCALAR_ONLY.test(value.trim())) {
    return "description is only a YAML block scalar header, so the text under it was not read. Indent every line of the description under the header by the same amount.";
  }
  if (value.length > DESCRIPTION_MAX) {
    return `description is longer than ${DESCRIPTION_MAX} characters. Shorten it to ${DESCRIPTION_MAX} characters or fewer, and move the detail into the body.`;
  }
  return null;
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  // Narrowing an object of unknown shape: `typeof === "object"` cannot
  // express indexability in TS, so the record read goes through this cast.
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === "string");
}
