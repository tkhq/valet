/**
 * Agent Skills frontmatter validation — https://agentskills.io/specification.
 *
 * Pure and I/O-free: it takes already-parsed frontmatter and returns the
 * violations it found. The name-matches-directory rule needs the directory
 * name as an input, because this module never touches the file system.
 *
 * It RETURNS violations rather than throwing, and grades each one. Callers
 * set the policy: `loadSkillFromMarkdown` and the authoring API refuse a
 * skill with any violation, because the author can fix it. An importer
 * mirroring somebody else's repository refuses only `error` violations and
 * reports the rest, because the author cannot fix that repository — see
 * `SkillSpecSeverity`.
 */

export type SkillSpecField =
  | "name"
  | "description"
  | "license"
  | "compatibility"
  | "metadata"
  | "allowed-tools"
  | "invocation"
  | "argHint";

/**
 * How much a violation matters.
 *
 * `error` — the skill is broken or the model cannot find it. Nothing should
 * load it.
 *
 * `advisory` — the skill works, but it breaks a limit the spec sets. Only
 * length overruns land here: the text is all present, there is just more of
 * it than the spec allows. A caller that mirrors somebody else's repository
 * should report an advisory and take the skill anyway, because the author
 * cannot edit that repository. A caller that accepts text from its own user
 * should refuse it, because the author can.
 */
export type SkillSpecSeverity = "error" | "advisory";

export interface SkillSpecViolation {
  field: SkillSpecField;
  severity: SkillSpecSeverity;
  /** States what is wrong, then what to do about it. */
  message: string;
}

/** True when nothing in `violations` blocks loading the skill. */
export function isLoadable(violations: SkillSpecViolation[]): boolean {
  return violations.every((v) => v.severity === "advisory");
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
  if (nameViolation) violations.push({ field: "name", severity: "error", message: nameViolation });

  const descriptionFinding = checkDescription(frontmatter.description);
  if (descriptionFinding) violations.push({ field: "description", ...descriptionFinding });

  if (frontmatter.license !== undefined && typeof frontmatter.license !== "string") {
    violations.push({
      field: "license",
      severity: "error",
      message: 'license is not text. Write a license name, or the name of a bundled license file.',
    });
  }

  const compatibility = frontmatter.compatibility;
  if (compatibility !== undefined) {
    if (typeof compatibility !== "string") {
      violations.push({
        field: "compatibility",
        severity: "error",
        message: "compatibility is not text. Write the environment requirements as one line of text.",
      });
    } else if (compatibility.length > COMPATIBILITY_MAX) {
      violations.push({
        field: "compatibility",
        severity: "advisory",
        message: `compatibility is longer than ${COMPATIBILITY_MAX} characters. Shorten it to ${COMPATIBILITY_MAX} characters or fewer.`,
      });
    }
  }

  if (frontmatter.metadata !== undefined && !isStringMap(frontmatter.metadata)) {
    violations.push({
      field: "metadata",
      severity: "error",
      message:
        "metadata is not a map of text values. Quote every value so each key maps to text.",
    });
  }

  const allowedTools = frontmatter["allowed-tools"];
  if (allowedTools !== undefined && typeof allowedTools !== "string") {
    violations.push({
      field: "allowed-tools",
      severity: "error",
      message:
        "allowed-tools is not text. Write the tool names as one space-separated line of text.",
    });
  }

  const invocation = frontmatter.invocation;
  if (invocation !== undefined && invocation !== "context" && invocation !== "prompt") {
    violations.push({
      field: "invocation",
      severity: "error",
      message: 'invocation is not "context" or "prompt". Set invocation to "context" or "prompt".',
    });
  }

  const argHint = frontmatter.argHint;
  if (argHint !== undefined && typeof argHint !== "string") {
    violations.push({
      field: "argHint",
      severity: "error",
      message: "argHint is not text. Write the argument hint as one line of text.",
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

type Finding = Omit<SkillSpecViolation, "field">;

function checkDescription(value: unknown): Finding | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return {
      severity: "error",
      message: "description is required. Write what the skill does and when to use it.",
    };
  }
  if (BLOCK_SCALAR_ONLY.test(value.trim())) {
    return {
      severity: "error",
      message:
        "description is only a YAML block scalar header, so the text under it was not read. Indent every line of the description under the header by the same amount.",
    };
  }
  if (value.length > DESCRIPTION_MAX) {
    return {
      severity: "advisory",
      message: `description is longer than ${DESCRIPTION_MAX} characters. Shorten it to ${DESCRIPTION_MAX} characters or fewer, and move the detail into the body.`,
    };
  }
  return null;
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  // Narrowing an object of unknown shape: `typeof === "object"` cannot
  // express indexability in TS, so the record read goes through this cast.
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === "string");
}
