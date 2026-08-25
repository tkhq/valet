/**
 * Which paths in a repository are skills. Pure functions over a recursive
 * tree listing, so every rule below is testable without a GitHub request.
 *
 * ## Why the whole repository is scanned
 *
 * Sync used to list ONE directory and read `<dir>/SKILL.md` under each entry
 * of it. That layout is the Agent Skills layout, so it worked, but it forced
 * the person adding a repository to type the directory that holds the skills.
 * A wrong or absent subdirectory found directories with no `SKILL.md` in
 * them, imported nothing, and reported success.
 *
 * One recursive tree read returns every path in the repository, so the
 * subdirectory is no longer needed to FIND the skills. It stays as a filter —
 * see `subpath` below.
 *
 * ## What counts as a skill
 *
 * A blob whose file name is exactly `SKILL.md`. Its skill name is the name of
 * the directory that holds it, at whatever depth that directory sits. The
 * match is case-sensitive: an agent runtime loads `SKILL.md`, so `skill.md`
 * is a different file and is not a skill.
 *
 * ## What counts as a prompt
 *
 * A blob whose file name ends `.md` and whose immediate parent directory is
 * named `prompts`. Its name is the file name without `.md`. Only a direct
 * child counts: a file deeper under `prompts/` is something a prompt
 * includes, not a prompt.
 *
 * ## Directories that are not scanned
 *
 * A whole-repository scan reaches files that are not the repository's own
 * skills: a dependency's `SKILL.md`, a build output's copy of one, a test
 * fixture written to exercise a parser. `EXCLUDED_DIRECTORIES` names them.
 *
 * The rule applies to the ANCESTORS of a candidate, never to the directory
 * the candidate is named after. `dist/skills/deploy/SKILL.md` is excluded
 * because `dist` is an ancestor. A skill legitimately named `build` sits at
 * `build/SKILL.md`, where `build` is its own directory and no ancestor is
 * excluded, so it is imported. Junk arrives nested; a skill name does not.
 *
 * A dot-prefixed ancestor is excluded too, because `.github`, `.vscode` and
 * `.venv` hold tooling. Two paths are the exceptions, and they are paths
 * rather than directory names: the whole `.claude` tree, and `.valet/skills`
 * alone. `.claude/skills/<name>/SKILL.md` is the most likely place for a real
 * skill, and opening `.claude` is what makes the plugin-tree names below
 * matter, because a downloaded plugin's skills sit under `.claude/plugins`.
 * `.valet` is Valet's own per-repository folder, and only its `skills`
 * subtree holds skills — see `SCANNED_DOT_PATHS`.
 *
 * Over-exclusion is recoverable without a new setting. The rules run on the
 * part of the path BELOW the subdirectory, so a source whose subdirectory is
 * `node_modules/@acme/skills` reaches inside an excluded tree deliberately.
 * It is also reported: `excludedCandidates` carries the paths, and a sync
 * that already mirrors one of those names keeps the row and warns rather
 * than deleting a skill this file decided not to look at.
 */
import type { SkillTreeEntry } from "./skill-repo-reader.js";

/** The file that makes a directory a skill. */
export const SKILL_FILE = "SKILL.md";
/** The directory whose `.md` children are prompts. */
export const PROMPTS_DIR = "prompts";

/**
 * The most candidates one sync imports from one repository.
 *
 * The tree read is one request, but each candidate still costs one request
 * to read its content, and those run one after the other. The directory walk
 * this replaced was bounded by `MAX_DIRECTORY_ENTRIES` (500) and failed
 * loudly above it. A non-truncated tree carries up to 100,000 entries, so
 * without a cap here a whole-repository scan can queue an unbounded run of
 * content reads — which an anonymous read (60 requests per hour per IP)
 * cannot finish, and which can outlast the sweep's claim lease.
 *
 * 300 sits under the directory walk's own limit and above any real skill
 * repository. A repository past it needs a subdirectory, and the error says
 * so. This is a guard against unbounded work, not a rate-limit calculation:
 * the anonymous budget is smaller than this on its own, and a first sync
 * that has to read 300 files needs a credential either way.
 */
export const MAX_SKILL_CANDIDATES = 300;

/**
 * Directory names that never hold a repository's own skills. Grouped by the
 * reason, because the reason is what a later reader needs to judge an
 * addition:
 *
 *   - dependency trees — a `SKILL.md` there belongs to another package;
 *   - build output — a copy of a file that also exists at its source;
 *   - test trees — fixtures written to exercise code that reads skills;
 *   - agent plugin trees — copies of OTHER people's skills, downloaded from
 *     a marketplace into `plugins/cache/<plugin>/<version>/skills/...` or
 *     `plugins/marketplaces/<name>/plugins/<plugin>/skills/...`. This is the
 *     vendoring layout of the ecosystem the feature serves, and it is the
 *     one that hurts most: a real `.claude` tree can hold more downloaded
 *     copies than own skills, and a downloaded copy that shares a name with
 *     an own skill makes the collision rule import NEITHER.
 *
 * `examples`, `docs`, `spec` and `samples` are deliberately absent. An
 * examples directory can hold real, importable skills, and "spec" does not
 * make a file a fake.
 */
export const EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  "bower_components",
  "vendor",
  "third_party",
  "thirdparty",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "test",
  "tests",
  "__tests__",
  "__mocks__",
  "testdata",
  "test-data",
  "fixtures",
  "__fixtures__",
  "cache",
  "marketplaces",
  "external_plugins",
]);

/**
 * The dot-prefixed PATHS this scan opens. Everything under one of them is
 * scanned; every other dot-prefixed ancestor is skipped.
 *
 * `.claude/skills/<name>/SKILL.md` is where an agent runtime keeps a
 * repository's own skills, so the whole `.claude` tree is open.
 *
 * `.valet` is open for `skills` and for nothing else. It is Valet's own
 * per-repository folder, and it already carries three conventions that are
 * not skills: `prebuild.yaml` configures the sandbox image, `persona` is
 * written by the runner, and `prompts/*.md` are the repository's own slash
 * commands, read from the prepared sandbox by
 * `engine/command-providers.ts`. Mirroring those prompt files as skills
 * would change what an already-tracked repository holds the moment it
 * upgraded, and a name held by both `.claude/prompts` and `.valet/prompts`
 * would collide on the owner-name unique index. Whether `.valet/prompts`
 * should become skills is a product question, and it is open.
 *
 * A source may still reach any of it deliberately, by naming the directory
 * as its `subpath` — the rules run below the subdirectory.
 */
const SCANNED_DOT_PATHS: readonly string[] = [".claude", ".valet/skills"];

/** Git's mode for a symbolic link. The blob behind one holds a path string,
 * not the file it points at, so a symlinked `SKILL.md` is not readable as a
 * skill. The contents endpoint reports the same path as `type: "symlink"`
 * and the reader answers null for it, so both discovery paths skip it. */
const SYMLINK_MODE = "120000";

/** One file that discovery decided is a skill or a prompt. */
export interface SkillCandidate {
  /** The skill name: the directory name for a skill, the file name without
   * `.md` for a prompt. */
  name: string;
  /** Path from the repository root. */
  path: string;
  /** Git blob sha. The manifest key, so a sync can tell a changed file from
   * an unchanged one without reading either. */
  blobSha: string;
  kind: "skill" | "prompt";
}

export interface TreeDiscovery {
  /** Candidates to import, after the collision rule. */
  accepted: SkillCandidate[];
  /** Names held by a candidate that discovery refused to import. The name is
   * still upstream, so reconcile must not delete the row that holds it. */
  reservedNames: Set<string>;
  /** One line per candidate that was found and not imported. */
  warnings: string[];
  /** Candidates that passed the shape test and the subdirectory filter,
   * before the collision rule. Zero means the repository holds no skill. */
  discovered: number;
  /**
   * Candidates dropped because an ancestor directory is not scanned, as
   * PATHS and not only a count.
   *
   * The count alone is not enough for the caller. The exclusion rule can be
   * wrong — a real skill can move under a name this file excludes — and when
   * it is wrong the file stops being a candidate, so reconcile reads its
   * absence as "deleted upstream" and removes a skill the repository still
   * holds. Reconcile needs the NAMES to test them against the rows it
   * already mirrors, which is the only place that mistake is visible.
   */
  excludedCandidates: SkillCandidate[];
}

/**
 * Every `SKILL.md` and `prompts/*.md` under `subpath`, with the collision
 * rule applied.
 *
 * `subpath` is a FILTER, not a requirement. Empty means the whole repository
 * counts. A value means only paths under that directory count, matched on a
 * whole segment: `skills` selects `skills/deploy/SKILL.md` and never
 * `skills-archive/deploy/SKILL.md`.
 */
export function discoverFromTree(entries: SkillTreeEntry[], subpath: string): TreeDiscovery {
  const prefix = subpath.length > 0 ? `${subpath}/` : "";
  const candidates: SkillCandidate[] = [];
  const excludedCandidates: SkillCandidate[] = [];
  const warnings: string[] = [];

  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    if (entry.mode === SYMLINK_MODE) continue;
    if (!entry.path.startsWith(prefix)) continue;
    const relative = entry.path.slice(prefix.length);
    const segments = relative.split("/");
    const fileName = segments[segments.length - 1];
    if (fileName === undefined) continue;

    const kind = candidateKind(fileName, segments);
    if (kind === null) continue;

    // A file at the top of the scan has no directory to take a name from.
    // Reporting it matters: a repository whose only `SKILL.md` sits at its
    // root must not be told that it holds none.
    if (segments.length < 2) {
      warnings.push(
        `${SKILL_FILE} at the top of the scan has no directory to name the skill. Move it into a directory named for the skill.`,
      );
      continue;
    }

    const name =
      kind === "skill" ? (segments[segments.length - 2] ?? "") : fileName.slice(0, -".md".length);
    if (name.length === 0) continue;
    const candidate: SkillCandidate = { name, path: entry.path, blobSha: entry.sha, kind };

    if (hasExcludedAncestor(segments)) {
      excludedCandidates.push(candidate);
      continue;
    }
    candidates.push(candidate);
  }

  const resolved = resolveNameCollisions(candidates);
  return {
    accepted: resolved.accepted,
    reservedNames: resolved.reservedNames,
    warnings: [...warnings, ...resolved.warnings],
    discovered: candidates.length,
    excludedCandidates,
  };
}

/**
 * True when `subpath` names a directory that exists at this commit.
 *
 * The tree read carries this for free, and the caller cannot do without it.
 * The old scan asked the contents endpoint for the subdirectory, so a
 * subdirectory that was renamed or that never existed answered 404 and
 * failed the sync, which kept the mirrored rows. A tree read never 404s on a
 * bad subdirectory: it returns the whole repository, the prefix filter
 * matches nothing, and "no skill under here" is indistinguishable from
 * "every skill was deleted upstream". Testing the directory itself is what
 * tells the two apart.
 *
 * An empty `subpath` is the repository root, which always exists.
 */
export function treeHoldsSubpath(entries: SkillTreeEntry[], subpath: string): boolean {
  if (subpath.length === 0) return true;
  const prefix = `${subpath}/`;
  return entries.some((entry) => entry.path === subpath || entry.path.startsWith(prefix));
}

/**
 * Applies the one-name-one-skill rule to a set of candidates.
 *
 * Two rules, and they differ because the ambiguity differs:
 *
 *   - A `SKILL.md` outranks a `prompts/<name>.md` of the same name. The rule
 *     is stated in terms of the KIND of the file, so which one wins never
 *     depends on where either sits. This is the rule that already shipped,
 *     back when a skill directory and a prompt file were the only two paths
 *     that could produce one name.
 *   - Two files of the SAME kind sharing a name import NEITHER. Nothing here
 *     can rank them: taking the first by sorted path would make the skill
 *     somebody gets depend on the names of unrelated directories, and a file
 *     added later could quietly displace the skill they use.
 *
 * Both cases warn, and the warning names every path, because the person who
 * can fix it is reading the repository and not this code.
 */
export function resolveNameCollisions(candidates: SkillCandidate[]): {
  accepted: SkillCandidate[];
  reservedNames: Set<string>;
  warnings: string[];
} {
  const byName = new Map<string, SkillCandidate[]>();
  for (const candidate of candidates) {
    const group = byName.get(candidate.name);
    if (group === undefined) byName.set(candidate.name, [candidate]);
    else group.push(candidate);
  }

  const accepted: SkillCandidate[] = [];
  const reservedNames = new Set<string>();
  const warnings: string[] = [];

  // Sorted so one repository always produces the same report.
  for (const name of [...byName.keys()].sort()) {
    const group = byName.get(name) ?? [];
    if (group.length === 1) {
      const only = group[0];
      if (only !== undefined) accepted.push(only);
      continue;
    }
    const skills = group.filter((c) => c.kind === "skill").sort(byPath);
    const prompts = group.filter((c) => c.kind === "prompt").sort(byPath);

    if (skills.length > 1) {
      const paths = [...skills, ...prompts].map((c) => c.path);
      warnings.push(
        `${name}: found at ${paths.join(" and ")}. Two skills cannot share a name, so Valet imported neither. Rename one directory, or set the subdirectory to the one that holds the skill you want.`,
      );
      reservedNames.add(name);
      continue;
    }
    if (skills.length === 1) {
      const winner = skills[0];
      if (winner !== undefined) accepted.push(winner);
      for (const prompt of prompts) {
        warnings.push(
          `${name}: ${prompt.path} collides with the skill at ${winner?.path ?? ""}. A skill and a prompt cannot share a name. Rename one of them.`,
        );
      }
      continue;
    }
    warnings.push(
      `${name}: found at ${prompts.map((c) => c.path).join(" and ")}. Two prompts cannot share a name, so Valet imported neither. Rename one file, or set the subdirectory to the one that holds the prompt you want.`,
    );
    reservedNames.add(name);
  }

  return { accepted, reservedNames, warnings };
}

/** `skill` for a `SKILL.md`, `prompt` for a direct `.md` child of a
 * `prompts` directory, null for everything else. */
function candidateKind(fileName: string, segments: string[]): "skill" | "prompt" | null {
  if (fileName === SKILL_FILE) return "skill";
  if (!fileName.endsWith(".md")) return null;
  return segments[segments.length - 2] === PROMPTS_DIR ? "prompt" : null;
}

/** True when a directory ABOVE the candidate's own directory is not scanned.
 * The last two segments are the candidate's own directory and its file name,
 * and neither is judged here — see the file comment.
 *
 * A dot-prefixed ancestor is judged on the whole path BELOW it, not on its
 * own name, because `.valet` is open for one subtree and shut for the rest
 * of itself. */
function hasExcludedAncestor(segments: string[]): boolean {
  return segments.slice(0, -2).some((segment, index) => {
    if (EXCLUDED_DIRECTORIES.has(segment)) return true;
    if (!segment.startsWith(".")) return false;
    return !isScannedDotPath(segments.slice(index).join("/"));
  });
}

/** True when a path that starts at a dot-prefixed directory is one the scan
 * opens. */
function isScannedDotPath(fromDotDirectory: string): boolean {
  return SCANNED_DOT_PATHS.some(
    (open) => fromDotDirectory === open || fromDotDirectory.startsWith(`${open}/`),
  );
}

function byPath(a: SkillCandidate, b: SkillCandidate): number {
  return a.path.localeCompare(b.path);
}
