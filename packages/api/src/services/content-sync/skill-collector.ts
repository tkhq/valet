/**
 * The skills collector — every rule that is true of skills and of nothing
 * else. `content-sync/service.ts` runs the sweep around it and states the
 * rules every collector holds to; read it first.
 * `services/skill-discovery.ts` holds the rules about which tree path is a
 * skill.
 *
 * `walkDirectory` is the narrow fallback for a repository whose tree GitHub
 * cuts: list the configured subdirectory, read
 * `<subdirectory>/<entry>/SKILL.md` under each directory in it, then list
 * `<subdirectory>/prompts`. One level, one directory, one request per
 * candidate.
 *
 * One skill rule has no counterpart on the rail: a name the owner already
 * holds is a per-skill warning, and the skill already there is left alone.
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
    // A partial listing must fail before reconcile reads it as a delete list:
    // every entry past the cut would look deleted.
    if (!listing.complete) {
      throw new SkillRepoListingTruncatedError(source.repoFullName, source.subpath);
    }
    const candidates: SkillCandidate[] = [];
    const text = new Map<string, string>();

    for (const dir of listing.entries) {
      if (dir.type !== "dir") continue;
      const path = joinPath(source.subpath, dir.name, SKILL_FILE);
      // A read fault fails the whole sync. Only null ("not there") is normal,
      // and it means the directory is not a skill.
      const file = await reader.readFile(source.repoFullName, path, headSha);
      if (file === null) continue;
      candidates.push({ name: dir.name, path, blobSha: file.blobSha, kind: "skill" });
      text.set(path, file.text);
    }

    const promptsDir = joinPath(source.subpath, PROMPTS_DIR);
    let promptListing;
    try {
      promptListing = await reader.listDirectory(source.repoFullName, promptsDir, headSha);
    } catch (err) {
      // A missing `prompts/` directory is normal and yields zero entries. Any
      // other read fault is a transport failure and must propagate.
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

    // The same collision rule as the tree path, so the two never disagree
    // about which of two same-named files is a skill.
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
  /** Candidates under a directory the scan skips. Carried whole, not counted,
   * so reconcile can test their names against the rows this source mirrors. */
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
    // Skills first, then prompts: reconcile reads them in that order, so a
    // skill directory wins the owner's name and a same-named prompt file
    // reports the collision instead of overwriting the row.
    this.readEntries = [...skillEntries, ...promptEntries];
    // Sorted per group, so the same commit hashes the same however GitHub
    // ordered the tree, and a tree read and a walk agree on a shared file.
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
   * scoped to `source_id` AND `origin='repo'`. A file that failed validation
   * and a name two files now claim both stay in that set: they are still
   * upstream, so their rows survive a typo in frontmatter.
   *
   * Two things narrow a scan, and neither may read as a delete: the directory
   * walk, which sees one level under one directory where the tree saw every
   * depth; and the exclusion rule, which can be wrong and must not destroy a
   * skill. Both keep the row and report it.
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

    // An excluded candidate is still a file the repository holds. A name this
    // source mirrors that the live scan found nowhere else was taken away by
    // the exclusion rule, so the name stays upstream and the row survives. A
    // name the scan DID find needs no warning: the excluded file is the copy.
    for (const candidate of this.excludedCandidates) {
      if (!byRowName.has(candidate.name) || upstream.has(candidate.name)) continue;
      upstream.add(candidate.name);
      warnings.push(
        `${candidate.name}: ${candidate.path} sits under a directory Valet does not scan, so this skill was not re-read. The skill already here is unchanged. Move the file out of that directory, or set the subdirectory that holds it.`,
      );
    }

    for (const entry of this.readEntries) {
      // Keyed by PATH, so a same-named skill directory and prompt file cannot
      // overwrite each other.
      const raw = text.get(entry.path);
      if (raw === undefined) continue;
      const isPrompt = this.promptNames.has(entry.name);
      const parsed = isPrompt ? parsePromptFile(raw, entry.name) : parseSkillFile(raw, entry.name);
      if (parsed.violations.length > 0) {
        warnings.push(`${entry.name}: ${parsed.violations.map((v) => v.message).join(" ")}`);
        // An advisory violation is reported and still mirrors: nobody here can
        // edit the upstream repository. An error skips the file.
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
    // The walk is narrower than the tree read that mirrored these rows, so its
    // absences prove nothing. A stale mirror is recoverable; a delete is not.
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
      // Scoped by source AND origin a second time, so this delete stays off a
      // local skill and off another source's rows even if the ids were wrong.
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
   * What this pass says about the REPOSITORY, as distinct from `warnings`,
   * which is one line per skill. Null when there is nothing to say.
   *
   * Two things go here. A sync that found no candidate at all names the fix
   * for each of the three reasons, and names how many mirrored skills it just
   * deleted. And a scan that used the directory walk says so on EVERY sync
   * that uses it: the walk applies no deletions, and a source whose deletions
   * never apply must not look healthy.
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
    // `skills_owner_name` is the only unique index, so a violation is a name
    // this owner already holds — a local skill, or another source's mirror.
    // Neither may be overwritten from here.
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
 * `loadSkillFromMarkdown` throws, which is wrong for a third party's
 * repository, so this calls the validator directly.
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
 * Parses one `prompts/<name>.md`. It differs from `SKILL.md`: `name` is the
 * filename stem and never a frontmatter field; `invocation` defaults to
 * `"prompt"` and takes only `"context"` beside it, any other value being an
 * error that skips the file; and `description` is optional.
 */
function parsePromptFile(raw: string, fileName: string): ParsedSkillFile {
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

/** A stable order for the manifest hash, so a listing's order cannot move it. */
function byName(entries: ContentManifestEntry[]): ContentManifestEntry[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}

/** Joins path parts, dropping the empty ones a root-level source produces. */
function joinPath(...parts: string[]): string {
  return parts.filter((part) => part.length > 0).join("/");
}
