/**
 * Domain notes: short rules for kinds of change the reviewer gets wrong
 * without them, matched to a pull request by path, by text in its added
 * lines, or by its title. They live in the team's memory, so each team
 * owns its rules; the plugin ships none.
 */

export interface DomainNote {
  /** File name without `.md`; a team-memory note with this name replaces the note. */
  name: string;
  title: string;
  /** Globs over changed paths (see `matchesGlob`). */
  paths: string[];
  /** Substrings of added lines that match the note. */
  terms: string[];
  /** Case-insensitive pattern over the PR title. */
  titlePattern?: string;
  /** Why the note cannot be used, such as a `title-pattern` that is not a valid regex. The pack skips it and logs this. */
  invalid?: string;
  body: string;
  /** Where the note came from: the team's memory, at `path`. */
  origin: "memory";
  path?: string;
}

/**
 * Parse a note in the playbook format: frontmatter with `title`, `paths`,
 * `terms` and `title-pattern` (lists as `[a, b]` or `- a` lines), then the
 * body. A file with no `paths`, `terms` or `title-pattern` matches nothing.
 */
export function parseNote(name: string, text: string, origin: DomainNote["origin"], path?: string): DomainNote {
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const meta = fm ? fm[1] : "";
  const body = fm ? text.slice(fm[0].length).trim() : text.trim();
  const scalar = (key: string): string | undefined => {
    const m = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(meta);
    if (!m) return undefined;
    const v = m[1].trim();
    // A double-quoted YAML scalar uses JSON escapes (memory renders every string this way).
    if (/^".*"$/.test(v)) {
      try {
        const decoded: unknown = JSON.parse(v);
        if (typeof decoded === "string") return decoded;
      } catch {
        // Not JSON-compatible: strip the quotes below.
      }
    }
    return v.replace(/^["']|["']$/g, "");
  };
  const list = (key: string): string[] => {
    // Memory renders a list stored in frontmatter extras as a quoted JSON array.
    const quoted = scalar(key);
    if (quoted?.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(quoted);
        if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string" && x.length > 0);
      } catch {
        // Not JSON: fall through to the YAML forms.
      }
    }
    const inline = new RegExp(`^${key}:\\s*\\[(.*)\\]\\s*$`, "m").exec(meta);
    if (inline) return inline[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    const block = new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s+.*\\n?)+)`, "m").exec(meta);
    if (!block) return [];
    return block[1].split("\n").map((l) => l.replace(/^\s+-\s+/, "").trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  };
  const titlePattern = scalar("title-pattern");
  let invalid: string | undefined;
  if (titlePattern) {
    try {
      new RegExp(titlePattern, "i");
    } catch (err) {
      invalid = `title-pattern is not a valid regex (${err instanceof Error ? err.message : String(err)}). Fix the pattern in the note.`;
    }
  }
  return {
    name,
    title: scalar("title") ?? name,
    paths: list("paths"),
    terms: list("terms"),
    ...(titlePattern && !invalid ? { titlePattern } : {}),
    ...(invalid ? { invalid } : {}),
    body,
    origin,
    ...(path ? { path } : {}),
  };
}

/** Why a note matches this change, or undefined when it does not. */
export function noteMatch(
  note: DomainNote,
  change: { paths: string[]; addedText: string; title: string },
  matchesGlob: (path: string, patterns: readonly string[]) => boolean,
): string | undefined {
  const path = note.paths.length > 0 ? change.paths.find((p) => matchesGlob(p, note.paths)) : undefined;
  if (path) return `path ${path}`;
  const term = note.terms.find((t) => change.addedText.includes(t));
  if (term) return `added text has \`${term}\``;
  if (note.titlePattern && new RegExp(note.titlePattern, "i").test(change.title)) return "PR title";
  return undefined;
}
