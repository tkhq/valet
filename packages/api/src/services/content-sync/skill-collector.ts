/**
 * The skills collector — every rule that is true of skills and of nothing
 * else. `services/content-sync/service.ts` runs the sweep around it and holds
 * no skill rule at all.
 *
 * ## Discovery
 *
 * One recursive tree read finds every `SKILL.md` in the repository, at any
 * depth. `services/skill-discovery.ts` holds the rules about which of those
 * paths is a skill, and its file comment is where they are explained.
 *
 * `subpath` is a filter over that scan, not the place the sync is told to
 * look. An empty subdirectory scans the whole repository, which is what makes
 * "import a repository and get its skills" work with nothing else typed.
 *
 * `walkDirectory` is the pre-tree discovery path: list the configured
 * subdirectory, read `<subdirectory>/<entry>/SKILL.md` under each directory
 * in it, then list `<subdirectory>/prompts`. It finds strictly less than the
 * tree read — one level, one directory — and costs one request per candidate
 * directory. It stays for one case: a repository with more than 100,000
 * files, where GitHub cuts the tree read.
 *
 * ## A malformed SKILL.md is not a failure
 *
 * It is a per-skill warning on an otherwise successful sync, so the new
 * commit IS recorded and the next poll stops after one call. Treating it as a
 * failure would re-read a file that will never parse, on every retry, for as
 * long as the source exists. The same rule covers a name the owner already
 * holds: the sync warns, and the skill already there is left alone.
 *
 * "Not there" for a file discovery DID find is not normal and is not a
 * failure either: the other skills still mirror, and `unreadWarning` names
 * the file. The sweep makes that pass incomplete, so the next poll re-reads.
 *
 * ## A delete needs a listing as wide as the one that imported
 *
 * Every path above can produce a listing NARROWER than the one that mirrored
 * the rows, and a narrower listing must not read as "deleted upstream". The
 * two narrowings, and what each does instead, are in `reconcile`. The rule
 * behind both: a stale mirror is recoverable on the next sync, and a deleted
 * skill is not.
 *
 * ## A sync that imports nothing says why
 *
 * "The repository could not be read", "the repository holds no SKILL.md" and
 * "the repository holds skills and they all failed" are three outcomes, and
 * `status: "ok"` with zero counts described all three. `notice` turns what
 * discovery found into one message that names what to do, including how many
 * mirrored skills the sync removed.
 */
import { and, eq, inArray } from "drizzle-orm";
import {
  isLoadable,
  parseMarkdownArtifact,
  validateSkillFrontmatter,
  BUILTIN_COMMAND_NAMES,
  type SkillSpecViolation,
} from "@valet/engine";
import { isPgUniqueViolation } from "@valet/store-postgres";
import type { AppDb } from "../../lib/drizzle.js";
import { skills, type ContentSourceRow, type SkillRow } from "../../schema/index.js";
import { newSkillId, skillContentSha } from "../skills.js";
import {
  SkillRepoListingTruncatedError,
  SkillRepoNotFoundError,
  type SkillRepoReader,
} from "../skill-repo-reader.js";
import {
  discoverFromTree,
  resolveNameCollisions,
  SKILL_FILE,
  PROMPTS_DIR,
  type SkillCandidate,
} from "../skill-discovery.js";
import type {
  CollectorDiscoverContext,
  CollectorNoticeContext,
  CollectorPass,
  CollectorReconcileContext,
  CollectorReconcileResult,
  CollectorWalkContext,
  ContentCollector,
  ContentManifestEntry,
} from "./collector.js";

export class SkillCollector implements ContentCollector {
  readonly kind = "skills" as const;

  discover({ entries, source }: CollectorDiscoverContext): CollectorPass {
    return new SkillPass(discoverFromTree(entries, source.subpath), new Map());
  }

  async walkDirectory({ source, headSha, reader }: CollectorWalkContext): Promise<CollectorPass> {
    const listing = await reader.listDirectory(source.repoFullName, source.subpath, headSha);
    // A partial listing must fail here, before reconcile reads it as a
    // delete list. `complete: false` says the listing holds fewer entries
    // than the directory does, and every entry past the cut would look
    // deleted.
    if (!listing.complete) {
      throw new SkillRepoListingTruncatedError(source.repoFullName, source.subpath);
    }
    const candidates: SkillCandidate[] = [];
    const text = new Map<string, string>();

    for (const dir of listing.entries) {
      if (dir.type !== "dir") continue;
      const path = joinPath(source.subpath, dir.name, SKILL_FILE);
      // A read fault here propagates and fails the whole sync. Only "the
      // file is not there" (null) is a normal answer, and it means the
      // directory is not a skill.
      const file = await reader.readFile(source.repoFullName, path, headSha);
      if (file === null) continue;
      candidates.push({ name: dir.name, path, blobSha: file.blobSha, kind: "skill" });
      text.set(path, file.text);
    }

    // Scan the `prompts/` directory. A 404 (no such directory) is normal and
    // produces zero prompt entries. Any other read fault propagates and fails
    // the whole sync, the same way a SKILL.md read fault does.
    const promptsDir = joinPath(source.subpath, PROMPTS_DIR);
    let promptListing;
    try {
      promptListing = await reader.listDirectory(source.repoFullName, promptsDir, headSha);
    } catch (err) {
      // SkillRepoNotFoundError means the prompts/ directory does not exist —
      // zero prompt entries, not a failure. SkillRepoReadError wraps other
      // non-404 responses, which ARE transport failures and must propagate.
      if (!(err instanceof SkillRepoNotFoundError)) throw err;
      promptListing = null;
    }

    if (promptListing !== null) {
      if (!promptListing.complete) {
        throw new SkillRepoListingTruncatedError(source.repoFullName, promptsDir);
      }
      for (const file of promptListing.entries) {
        if (file.type !== "file" || !file.name.endsWith(".md")) continue;
        const name = file.name.slice(0, -".md".length);
        const path = joinPath(promptsDir, file.name);
        const read = await reader.readFile(source.repoFullName, path, headSha);
        if (read === null) continue;
        candidates.push({ name, path, blobSha: read.blobSha, kind: "prompt" });
        text.set(path, read.text);
      }
    }

    // The same collision rule as the tree path, so the two paths never
    // disagree about which of two same-named files is a skill.
    const resolved = resolveNameCollisions(candidates);
    return new SkillPass(
      { ...resolved, discovered: candidates.length, excludedCandidates: [] },
      text,
    );
  }
}

/** What discovery produced, whichever path found it. */
interface SkillDiscovery {
  accepted: SkillCandidate[];
  /** Names a candidate holds that discovery would not import. Still upstream,
   * so reconcile keeps the rows that hold them. */
  reservedNames: Set<string>;
  warnings: string[];
  discovered: number;
  /** Files that are `SKILL.md` or `prompts/*.md` and sit under a directory
   * the scan skips. Carried as candidates, not a count, so reconcile can test
   * their names against the rows this source mirrors. */
  excludedCandidates: SkillCandidate[];
}

/** One commit's skill files, and the writes bound to them. */
class SkillPass implements CollectorPass {
  readonly kind = "skills" as const;
  readonly readEntries: ContentManifestEntry[];
  readonly manifestEntries: ContentManifestEntry[];
  readonly warnings: string[];
  readonly discovered: number;
  readonly excluded: number;

  /** Names that came from `prompts/`, so reconcile parses them differently. */
  private readonly promptNames: Set<string>;
  private readonly reservedNames: Set<string>;
  private readonly excludedCandidates: SkillCandidate[];

  constructor(
    found: SkillDiscovery,
    readonly text: Map<string, string>,
  ) {
    const skillEntries: ContentManifestEntry[] = [];
    const promptEntries: ContentManifestEntry[] = [];
    const promptNames = new Set<string>();
    for (const candidate of found.accepted) {
      const entry = { name: candidate.name, path: candidate.path, blobSha: candidate.blobSha };
      if (candidate.kind === "prompt") {
        promptEntries.push(entry);
        promptNames.add(candidate.name);
      } else {
        skillEntries.push(entry);
      }
    }
    // Skills first, then prompts. Reconcile reads them in that order, so a
    // skill directory wins the owner's name and a same-named prompt file
    // reports the collision rather than overwriting the row.
    this.readEntries = [...skillEntries, ...promptEntries];
    // The hash input sorts each group by name, so the same commit produces
    // the same hash however GitHub ordered the tree, and a tree read and a
    // directory walk agree on a file they both found.
    this.manifestEntries = [...byName(skillEntries), ...byName(promptEntries)];
    this.promptNames = promptNames;
    this.reservedNames = found.reservedNames;
    this.warnings = found.warnings;
    this.discovered = found.discovered;
    this.excludedCandidates = found.excludedCandidates;
    this.excluded = found.excludedCandidates.length;
  }

  unreadWarning(path: string): string {
    return `${path} was in the repository listing and could not be read, so this skill was not imported. Valet reads it again on the next sync. If it stays, check that the path is a file and not a symbolic link.`;
  }

  /**
   * Brings this source's mirrored skills in line with what the commit holds.
   *
   * The delete is a set reconcile over the names the repository still holds,
   * scoped to `source_id` AND `origin='repo'`. A directory that failed
   * validation stays in that set: it is still upstream, so its previous row
   * is kept rather than deleted on the strength of a typo in its frontmatter.
   * `reservedNames` is in the set for the same reason: a name two files now
   * claim is still a name the repository holds.
   *
   * ## A delete needs a listing as wide as the one that imported
   *
   * "Absent from this scan" only means "deleted upstream" when this scan
   * looked everywhere the last one did. Two things narrow a scan, and both
   * are handled here rather than left to read as deletions:
   *
   *   - The directory walk. It runs only when GitHub cut the tree, and it
   *     sees ONE level under ONE directory, where the tree saw the whole
   *     repository at any depth. A skill the tree imported from
   *     `<dir>/team/escalate/SKILL.md` is invisible to the walk, so the walk
   *     never deletes: it imports and updates, and reports what it kept.
   *   - The exclusion rule. A file that moved under an excluded directory
   *     stops being a candidate, which is indistinguishable from the file
   *     being deleted. An excluded name that this source already mirrors
   *     keeps its row and warns, because the rule can be wrong and a wrong
   *     rule must not destroy a skill.
   */
  async reconcile(ctx: CollectorReconcileContext): Promise<CollectorReconcileResult> {
    const { db, source, text } = ctx;
    const existing = await db
      .select()
      .from(skills)
      .where(and(eq(skills.sourceId, source.id), eq(skills.origin, "repo")));
    const byRowName = new Map(existing.map((row) => [row.name, row]));
    const upstream = new Set([
      ...this.readEntries.map((e) => e.name),
      ...this.reservedNames,
    ]);

    const warnings: string[] = [];
    let imported = 0;
    let updated = 0;

    // An excluded candidate is still a file the repository holds. When its
    // name is one this source mirrors AND the live scan did not find that
    // name anywhere else, the exclusion rule is what took the skill away, so
    // the name stays upstream and the row survives. The warning names the
    // path, because the person reading it is the only one who can say
    // whether that path is a real skill or a downloaded copy.
    //
    // A name the scan DID find needs neither: the skill is imported from its
    // real path, and the excluded file is the copy. Warning about it would
    // put a standing false alarm on every source whose repository vendors a
    // skill of the same name.
    for (const candidate of this.excludedCandidates) {
      if (!byRowName.has(candidate.name) || upstream.has(candidate.name)) continue;
      upstream.add(candidate.name);
      warnings.push(
        `${candidate.name}: ${candidate.path} sits under a directory Valet does not scan, so this skill was not re-read. The skill already here is unchanged. Move the file out of that directory, or set the subdirectory that holds it.`,
      );
    }

    for (const entry of this.readEntries) {
      // Content is keyed by PATH to prevent a same-named skill directory and
      // prompt file from silently overwriting each other in the map.
      const raw = text.get(entry.path);
      if (raw === undefined) continue;
      const isPrompt = this.promptNames.has(entry.name);
      const parsed = isPrompt ? parsePromptFile(raw, entry.name) : parseSkillFile(raw, entry.name);
      if (parsed.violations.length > 0) {
        warnings.push(`${entry.name}: ${parsed.violations.map((v) => v.message).join(" ")}`);
        // An advisory violation is reported but does not stop the mirror.
        // Nobody here can edit the upstream repository, so refusing the
        // skill would only make the corpus incomplete. An error means the
        // skill is broken or unfindable, and that one is skipped.
        if (!isLoadable(parsed.violations)) continue;
      }
      const row = byRowName.get(entry.name);
      if (row === undefined) {
        const wrote = await insertMirror(db, source, entry, parsed, ctx.now());
        if (wrote) imported += 1;
        else if (isPrompt) {
          warnings.push(
            `${entry.name}: ${entry.path} collides with an existing skill of the same name. Rename one of them.`,
          );
        } else {
          warnings.push(
            `${entry.name}: a skill with this name already exists here. Rename the skill directory, or remove the skill that holds the name.`,
          );
        }
        continue;
      }
      if (await updateMirror(db, row, entry, parsed, ctx.now())) updated += 1;
    }

    const stale = existing.filter((row) => !upstream.has(row.name));
    // The directory walk is narrower than the tree read that mirrored these
    // rows, so its absences prove nothing. A stale mirror is recoverable —
    // the next sync on a tree that fits deletes what is really gone — and a
    // deleted skill is not.
    if (ctx.discovery === "directory-walk") {
      return {
        imported,
        updated,
        deleted: 0,
        keptStale: stale.map((row) => row.name),
        warnings,
      };
    }
    if (stale.length > 0) {
      // Scoped by source AND origin a second time: this delete must stay off
      // a local skill and off another source's rows even if the id list were
      // ever computed wrong.
      await db
        .delete(skills)
        .where(
          and(
            inArray(
              skills.id,
              stale.map((row) => row.id),
            ),
            eq(skills.sourceId, source.id),
            eq(skills.origin, "repo"),
          ),
        );
    }
    return { imported, updated, deleted: stale.length, keptStale: [], warnings };
  }

  /**
   * What this pass needs to say about the REPOSITORY, as distinct from
   * `warnings`, which is one line per skill. Null when there is nothing to
   * say. Several lines when several apply.
   *
   * Two things go here.
   *
   * ## A sync that imported nothing
   *
   * Three outcomes used to look the same on the row, and only one of them is
   * the person's own doing. So each names a different action:
   *
   *   - candidates exist, and every one sits under a directory Valet does not
   *     scan — the fix is to name that directory;
   *   - no candidate at all under a configured subdirectory — the subdirectory
   *     is probably wrong, and removing it scans everything;
   *   - no candidate anywhere in the repository — the repository holds no
   *     skill, or the branch is wrong.
   *
   * Each of those also names how many mirrored skills the sync just deleted,
   * when it deleted any. The count is the part the reader acts on: advice to
   * re-import is no use if it arrives without saying that the skills are gone.
   *
   * A repository that DID yield candidates gets no line here even when every
   * one of them failed validation, because those skills each carry their own
   * warning and a second message about the repository would hide them.
   *
   * ## A scan that could not cover the repository
   *
   * The directory walk runs on a repository too large for one tree read, and
   * it applies no deletions (see `reconcile`). That is a standing limitation
   * of that source, not a one-off, so it is reported on every sync that uses
   * the walk — a source whose deletions never apply must not look healthy.
   */
  notice(ctx: CollectorNoticeContext): string | null {
    const { source } = ctx;
    const where = `${source.repoFullName} on ${source.ref.length > 0 ? source.ref : "the default branch"}`;
    const lines: string[] = [];

    if (ctx.discovery === "directory-walk") {
      const scanned = source.subpath.length > 0 ? source.subpath : "the repository root";
      const kept =
        ctx.keptStale.length === 0
          ? ""
          : ` Valet kept ${ctx.keptStale.length} mirrored ${ctx.keptStale.length === 1 ? "skill" : "skills"} this scan did not reach: ${ctx.keptStale.join(", ")}.`;
      lines.push(
        `${where} holds more files than Valet can read in one listing, so Valet read only ${scanned}, one level deep. A skill in a deeper directory is not imported, and no skill is deleted.${kept} Remove this repository, then import the /tree/ URL of the directory that holds the skills.`,
      );
    }

    if (this.discovered === 0) {
      const removed =
        ctx.deleted === 0
          ? ""
          : ` Valet removed the ${ctx.deleted} ${ctx.deleted === 1 ? "skill" : "skills"} it had mirrored from this source.`;
      if (this.excluded > 0) {
        lines.push(
          `Valet found ${this.excluded} ${SKILL_FILE} ${this.excluded === 1 ? "file" : "files"} in ${where}, all under directories it does not scan: dependencies, build output, tests, and downloaded agent plugins.${removed} Set the subdirectory that holds the skills, by importing its /tree/ URL.`,
        );
      } else if (source.subpath.length > 0) {
        lines.push(
          `Valet read ${where} and found no ${SKILL_FILE} file under ${source.subpath}.${removed} Check the subdirectory, or remove the source and import the repository again without one.`,
        );
      } else {
        lines.push(
          `Valet read ${where} and found no ${SKILL_FILE} file.${removed} Add a directory that holds a ${SKILL_FILE} file, or check the branch.`,
        );
      }
    }

    return lines.length === 0 ? null : lines.join("\n");
  }
}

/** Returns false when the owner already holds that skill name. */
async function insertMirror(
  db: AppDb,
  source: ContentSourceRow,
  entry: ContentManifestEntry,
  parsed: ParsedSkillFile,
  now: number,
): Promise<boolean> {
  const row: SkillRow = {
    id: newSkillId(),
    orgId: source.orgId,
    ownerType: source.ownerType,
    ownerId: source.ownerId,
    origin: "repo",
    sourceId: source.id,
    name: parsed.name,
    description: parsed.description,
    content: parsed.body,
    frontmatter: parsed.frontmatter,
    contentSha: skillContentSha(parsed.body),
    upstreamPath: entry.path,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await db.insert(skills).values(row);
    return true;
  } catch (err) {
    // `skills_owner_name` is the only unique index, so a violation is a
    // name this owner already holds — a local skill, or another source's
    // mirror. Neither may be overwritten from here.
    if (isPgUniqueViolation(err)) return false;
    throw err;
  }
}

/** Returns true when the row actually changed. */
async function updateMirror(
  db: AppDb,
  row: SkillRow,
  entry: ContentManifestEntry,
  parsed: ParsedSkillFile,
  now: number,
): Promise<boolean> {
  const contentSha = skillContentSha(parsed.body);
  const unchanged =
    row.contentSha === contentSha &&
    row.description === parsed.description &&
    row.upstreamPath === entry.path;
  if (unchanged) return false;
  await db
    .update(skills)
    .set({
      description: parsed.description,
      content: parsed.body,
      frontmatter: parsed.frontmatter,
      contentSha,
      upstreamPath: entry.path,
      updatedAt: now,
    })
    .where(eq(skills.id, row.id));
  return true;
}

interface ParsedSkillFile {
  name: string;
  description: string;
  body: string;
  frontmatter: Record<string, unknown>;
  violations: SkillSpecViolation[];
}

/**
 * Parses one `SKILL.md` and checks it against the spec WITHOUT throwing.
 * `loadSkillFromMarkdown` throws, which is right for the skills we ship and
 * wrong for a third party's repository, so this calls the validator directly
 * — the split the validator was written for.
 */
function parseSkillFile(raw: string, directoryName: string): ParsedSkillFile {
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
 * Parses one `prompts/<name>.md` file. Prompt files differ from `SKILL.md`
 * in three ways:
 *
 * 1. `name` is the filename stem, never a frontmatter field.
 * 2. `invocation` defaults to `"prompt"` when absent. `"context"` is the only
 *    other valid value; any other value is an error violation and the file is
 *    skipped.
 * 3. `description` is optional (the spec requires it for SKILL.md; prompts
 *    may omit it).
 *
 * Name validation reuses `validateSkillFrontmatter` but only the `name` field
 * matters — the description-missing violation is suppressed for prompts.
 */
function parsePromptFile(raw: string, fileName: string): ParsedSkillFile {
  const parsed = parseMarkdownArtifact(raw);

  // Validate the name (from the filename) via the skill spec, but skip the
  // description check — prompts may omit it.
  const nameViolations = validateSkillFrontmatter(
    { name: fileName, description: "placeholder" },
    { directoryName: fileName },
  ).filter((v) => v.field !== "description");

  // Also reject reserved builtin names.
  if ((BUILTIN_COMMAND_NAMES as readonly string[]).includes(fileName)) {
    nameViolations.push({
      field: "name",
      severity: "error",
      message: `"${fileName}" is a reserved built-in command name. Rename the file.`,
    });
  }

  // Validate the invocation field.
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

  // Only set the resolved `invocation` when it is valid. When the raw value
  // was invalid, `invocationViolations` carries an error and the file will be
  // skipped — the frontmatter is never persisted, but returning a misleading
  // value is still confusing to callers and tests.
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

/** A stable order for the manifest hash, so a listing's order cannot move it. */
function byName(entries: ContentManifestEntry[]): ContentManifestEntry[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}

/** Joins path parts, dropping the empty ones a root-level source produces. */
function joinPath(...parts: string[]): string {
  return parts.filter((part) => part.length > 0).join("/");
}
