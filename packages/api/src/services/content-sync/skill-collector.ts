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
 * `<subdirectory>/prompts`. Each discovered skill also needs a complete
 * subtree read for its companion files.
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
  type SkillFile,
} from "@valet/engine";
import { isPgUniqueViolation } from "@valet/store-postgres";
import type { AppDb } from "../../lib/drizzle.js";
import { canonicalJson } from "../../lib/canonical-json.js";
import { skills, skillFiles, contentSources, type SkillWalkCache, type ContentSourceRow, type SkillRow } from "../../schema/index.js";
import { newSkillId } from "../skills.js";
import {
  SkillRepoListingTruncatedError,
  SkillRepoTooManySkillsError,
  SkillRepoNotFoundError,
  type SkillRepoReader,
  type SkillTreeEntry,
} from "../skill-repo-reader.js";
import {
  discoverFromTree,
  MAX_SKILL_CANDIDATES,
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

import { indexCompanions, readSkillFiles, skillWithFilesSha, type SkillBlob } from "./skill-files.js";

export class SkillCollector implements ContentCollector {
  readonly kind = "skills" as const;

  discover({ entries, source }: CollectorDiscoverContext): CollectorPass {
    const found = discoverFromTree(entries, source.subpath);
    if (found.discovered > MAX_SKILL_CANDIDATES) throw new SkillRepoTooManySkillsError(source.repoFullName, found.discovered, MAX_SKILL_CANDIDATES);
    return new SkillPass(found, new Map(), entries);
  }

  async walkDirectory({ db, source, headSha, reader, bodyReader }: CollectorWalkContext): Promise<CollectorPass> {
    const listing = await bodyReader.listDirectory(source.repoFullName, source.subpath, headSha);
    // A partial listing must fail before reconcile reads it as a delete list:
    // every entry past the cut would look deleted.
    if (!listing.complete) {
      throw new SkillRepoListingTruncatedError(source.repoFullName, source.subpath);
    }
    const candidates: SkillCandidate[] = [];
    const text = new Map<string, string>();
    const entries: SkillTreeEntry[] = [];
    const subtrees: { path: string; sha: string; bodySha: string; prefix: string }[] = [];
    const unavailable = new Set<string>();
    const unreadBodies: string[] = [];
    const walkCache: SkillWalkCache = {};
    const rows = await db.select({ path: skills.upstreamPath, bodySha: skills.upstreamBlobSha,
      content: skills.content, frontmatter: skills.frontmatter }).from(skills)
      .where(and(eq(skills.sourceId, source.id), eq(skills.origin, "repo")));
    const stored = new Map(rows.map(row => [row.path, row]));

    const readBody = async (path: string, identity: string) => {
      const cached = source.skillWalkCache[path];
      const row = stored.get(path);
      if (cached?.directorySha === identity && cached.bodySha === null) {
        walkCache[path] = cached;
        return null;
      }
      const file = cached?.directorySha === identity && row?.bodySha === cached.bodySha
        ? { blobSha: row.bodySha!, text: `---\n${JSON.stringify(row.frontmatter)}\n---\n${row.content}` }
        : await bodyReader.readFile(source.repoFullName, path, headSha);
      walkCache[path] = { ...(cached?.directorySha === identity ? cached : {}), directorySha: identity, bodySha: file?.blobSha ?? null };
      return file;
    };

    for (const dir of listing.entries) {
      if (dir.type !== "dir") continue;
      const path = joinPath(source.subpath, dir.name, SKILL_FILE);
      let file;
      try { file = await readBody(path, dir.sha); }
      catch { unreadBodies.push(path); continue; }
      if (file === null) continue;
      candidates.push({
        name: dir.name,
        path,
        relative: joinPath(dir.name, SKILL_FILE),
        blobSha: file.blobSha,
        kind: "skill",
      });
      if (candidates.length > MAX_SKILL_CANDIDATES) throw new SkillRepoTooManySkillsError(source.repoFullName, candidates.length, MAX_SKILL_CANDIDATES);
      text.set(path, file.text);
      subtrees.push({ path, sha: dir.sha, bodySha: file.blobSha, prefix: joinPath(source.subpath, dir.name) });
    }

    const promptsDir = joinPath(source.subpath, PROMPTS_DIR);
    let promptListing;
    try {
      promptListing = await bodyReader.listDirectory(source.repoFullName, promptsDir, headSha);
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
        let read;
        try { read = await readBody(path, file.sha); }
        catch { unreadBodies.push(path); continue; }
        if (read === null) continue;
        candidates.push({
          name,
          path,
          relative: joinPath(PROMPTS_DIR, file.name),
          blobSha: read.blobSha,
          kind: "prompt",
        });
        text.set(path, read.text);
      }
    }

    if (candidates.length > MAX_SKILL_CANDIDATES) throw new SkillRepoTooManySkillsError(source.repoFullName, candidates.length, MAX_SKILL_CANDIDATES);
    // Read every body before companion subtree discovery can consume the budget.
    for (const { path, sha, bodySha, prefix } of subtrees) {
      let subtree;
      try {
        const cached = walkCache[path]?.entries;
        subtree = cached ? { entries: cached, truncated: false } : await reader.listTree(source.repoFullName, sha);
      }
      catch (err) {
        if (err instanceof SkillRepoListingTruncatedError) throw err;
        unavailable.add(path);
        continue;
      }
      if (subtree.truncated) throw new SkillRepoListingTruncatedError(source.repoFullName, path);
      walkCache[path]!.entries = subtree.entries;
      entries.push({ path, sha: bodySha, type: "blob", mode: "100644" });
      entries.push(...subtree.entries.map(entry => ({ ...entry, path: `${prefix}/${entry.path}` })));
    }

    // The same collision rule as the tree path, so the two never disagree
    // about which of two same-named files is a skill.
    const resolved = resolveNameCollisions(candidates);
    for (const path of unreadBodies) {
      const parts = path.split("/");
      resolved.reservedNames.add(path.endsWith("/SKILL.md") ? parts.at(-2)! : parts.at(-1)!.slice(0, -3));
    }
    return new SkillPass(
      { ...resolved, discovered: candidates.length, excludedCandidates: [] },
      text,
      entries,
      unavailable,
      walkCache,
      unreadBodies,
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

  private readonly companionFiles = new Map<string, SkillTreeEntry[]>();
  private readonly preparedFiles = new Map<string, SkillFile[]>();
  private readonly fileWarnings: string[] = [];
  private readonly deferred: string[] = [];
  /** Names that came from `prompts/`, so reconcile parses them differently. */
  private readonly promptNames: Set<string>;
  private readonly reservedNames: Set<string>;
  private readonly excludedCandidates: SkillCandidate[];

  constructor(
    found: SkillDiscovery,
    readonly text: Map<string, string>,
    tree: SkillTreeEntry[],
    private readonly unavailable = new Set<string>(),
    private readonly walkCache?: SkillWalkCache,
    unreadBodies: string[] = [],
  ) {
    this.deferred.push(...unreadBodies);
    this.fileWarnings.push(...unreadBodies.map(path => `${path}: The body could not be read. Saved other bodies. Sync again to retry.`));
    const companions = indexCompanions(tree);
    const skillEntries: ContentManifestEntry[] = [];
    const promptEntries: ContentManifestEntry[] = [];
    const promptNames = new Set<string>();
    for (const candidate of found.accepted) {
      const entry = { name: candidate.name, path: candidate.path, blobSha: candidate.blobSha };
      if (candidate.kind === "prompt") {
        promptEntries.push(entry);
        promptNames.add(candidate.name);
      } else {
        this.companionFiles.set(candidate.path, companions.get(candidate.path) ?? []);
        skillEntries.push(entry);
      }
    }
    // Skills first, then prompts: reconcile reads them in that order, so a
    // skill directory wins the owner's name and a same-named prompt file
    // reports the collision instead of overwriting the row.
    this.readEntries = [...skillEntries, ...promptEntries];
    // Sorted per group, so the same commit hashes the same however GitHub
    // ordered the tree, and a tree read and a walk agree on a shared file.
    this.manifestEntries = [...byName(skillEntries), ...byName(promptEntries),
      ...[...this.companionFiles].flatMap(([path, entries]) => entries.map((entry) => ({
        name: path, path: entry.path, blobSha: `${entry.sha}:${entry.mode}`,
      }))).sort((a, b) => a.path.localeCompare(b.path)),
    ];
    this.promptNames = promptNames;
    this.reservedNames = found.reservedNames;
    this.warnings = found.warnings;
    this.discovered = found.discovered;
    this.excludedCandidates = found.excludedCandidates;
    this.excluded = found.excludedCandidates.length;
  }

  async hydrateBodies(ctx: CollectorReconcileContext): Promise<void> {
    const rows = await ctx.db.select({ path: skills.upstreamPath, blobSha: skills.upstreamBlobSha,
      content: skills.content, frontmatter: skills.frontmatter }).from(skills)
      .where(and(eq(skills.sourceId, ctx.source.id), eq(skills.origin, "repo")));
    const cached = new Map(rows.map(row => [row.path, row]));
    for (const entry of this.readEntries) {
      const row = cached.get(entry.path);
      if (row?.blobSha === entry.blobSha && !this.text.has(entry.path)) {
        this.text.set(entry.path, `---\n${JSON.stringify(row.frontmatter)}\n---\n${row.content}`);
      }
    }
  }

  async prepareReconcile(ctx: CollectorReconcileContext): Promise<(db: AppDb) => Promise<CollectorReconcileResult>> {
    if (!ctx.reader) throw new Error("Skill sync needs a repository reader.");
    const previous = await ctx.db.select({ file: { path: skillFiles.path, blobSha: skillFiles.blobSha,
      size: skillFiles.size, mode: skillFiles.mode }, upstreamPath: skills.upstreamPath })
      .from(skillFiles).innerJoin(skills, eq(skillFiles.skillId, skills.id))
      .where(and(eq(skills.sourceId, ctx.source.id), eq(skills.origin, "repo")));
    const previousByPath = new Map<string | null, SkillFile[]>();
    for (const row of previous) {
      const files = previousByPath.get(row.upstreamPath) ?? [];
      files.push(row.file);
      previousByPath.set(row.upstreamPath, files);
    }
    const reads = new Map<string, SkillBlob | null>();
    const remaining = new Map<string, number>();
    for (const entries of this.companionFiles.values()) for (const entry of entries) remaining.set(entry.sha, (remaining.get(entry.sha) ?? 0) + 1);
    for (const [path, entries] of this.companionFiles) {
      if (!ctx.text.has(path)) continue;
      const previousFiles = previousByPath.get(path) ?? [];
      const unavailable = this.unavailable.has(path);
      const listed = unavailable ? previousFiles.map(file => ({ path: path.slice(0, -"SKILL.md".length) + file.path,
        sha: file.blobSha, size: file.size, mode: file.mode, type: "blob" })) : entries;
      if (unavailable) this.fileWarnings.push(`${path}: Companion discovery was deferred. Saved the body. Sync again to retry the files.`);
      const result = await readSkillFiles(ctx.reader, ctx.source.repoFullName, ctx.commitSha, path,
        listed, previousFiles, reads);
      for (const entry of entries) {
        const count = (remaining.get(entry.sha) ?? 1) - 1;
        remaining.set(entry.sha, count);
        if (count === 0) reads.delete(entry.sha);
      }
      if (result.warning) {
        this.fileWarnings.push(`${path}: ${result.warning}`);
      }
      if (result.deferred || unavailable) this.deferred.push(path);
      this.preparedFiles.set(path, result.files);
    }
    reads.clear();
    return (db) => this.reconcile({ ...ctx, db }).finally(() => this.preparedFiles.clear());
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
    if (this.walkCache) await db.update(contentSources).set({ skillWalkCache: this.walkCache }).where(eq(contentSources.id, source.id));
    const existing = await db
      .select()
      .from(skills)
      .where(and(eq(skills.sourceId, source.id), eq(skills.origin, "repo")));
    const byRowName = new Map(existing.map((row) => [row.name, row]));
    const upstream = new Set([
      ...this.readEntries.map((e) => e.name),
      ...this.reservedNames,
    ]);

    const warnings: string[] = [...this.fileWarnings];
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
      const files = this.preparedFiles.get(entry.path) ?? [];
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
        const wrote = await insertMirror(db, source, entry, parsed, files, ctx.now());
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
        this.preparedFiles.delete(entry.path);
        continue;
      }
      if (await updateMirror(db, row, entry, parsed, files, ctx.now())) updated += 1;
      this.preparedFiles.delete(entry.path);
    }

    const stale = existing.filter((row) => !upstream.has(row.name));
    // The walk is narrower than the tree read that mirrored these rows, so its
    // absences prove nothing. A stale mirror is recoverable; a delete is not.
    if (ctx.discovery === "directory-walk") {
      return {
        imported,
        updated,
        deleted: 0,
        deferred: this.deferred,
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
    return { imported, updated, deleted: stale.length, keptStale: [], deferred: this.deferred, warnings };
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
  files: SkillFile[],
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
    contentSha: skillWithFilesSha(parsed.body, files),
    upstreamPath: entry.path,
    upstreamBlobSha: entry.blobSha,
    createdAt: now,
    updatedAt: now,
  };
  try {
    // Keep a handled name collision from aborting the source transaction.
    await db.transaction(async (tx) => {
      await tx.insert(skills).values(row);
      await writeFiles(tx, row.id, files);
    });
    return true;
  } catch (err) {
    // `skills_owner_name` is the only unique index, so a violation is a name
    // this owner already holds — a local skill, or another source's mirror.
    // Neither may be overwritten from here.
    if (isPgUniqueViolation(err)) return false;
    throw err;
  }
}

async function writeFiles(db: AppDb, skillId: string, files: SkillFile[]): Promise<void> {
  const keep = new Set(files.map((file) => file.path));
  const previous = await db.select({ path: skillFiles.path }).from(skillFiles).where(eq(skillFiles.skillId, skillId));
  for (const file of previous) {
    if (!keep.has(file.path)) await db.delete(skillFiles).where(and(eq(skillFiles.skillId, skillId), eq(skillFiles.path, file.path)));
  }
  for (const file of files) {
    if (file.bytes) {
      await db.insert(skillFiles).values({ ...file, bytes: file.bytes, skillId }).onConflictDoUpdate({
        target: [skillFiles.skillId, skillFiles.path], set: file,
      });
    } else {
      await db.update(skillFiles).set({ mode: file.mode }).where(and(
        eq(skillFiles.skillId, skillId), eq(skillFiles.path, file.path), eq(skillFiles.blobSha, file.blobSha),
      ));
    }
  }
}

/** Returns true when the row actually changed. */
async function updateMirror(
  db: AppDb,
  row: SkillRow,
  entry: ContentManifestEntry,
  parsed: ParsedSkillFile,
  files: SkillFile[],
  now: number,
): Promise<boolean> {
  const contentSha = skillWithFilesSha(parsed.body, files);
  // Frontmatter-only edits must update the mirror even when its body is unchanged.
  const unchanged =
    row.contentSha === contentSha &&
    canonicalJson(row.frontmatter) === canonicalJson(parsed.frontmatter) &&
    row.description === parsed.description &&
    row.upstreamPath === entry.path &&
    row.upstreamBlobSha === entry.blobSha;
  if (unchanged) return false;
  await writeFiles(db, row.id, files);
  await db
    .update(skills)
    .set({
      description: parsed.description,
      content: parsed.body,
      frontmatter: parsed.frontmatter,
      contentSha,
      upstreamPath: entry.path,
      upstreamBlobSha: entry.blobSha,
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
