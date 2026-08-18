/**
 * Skill sync — mirrors a GitHub repository's skills into the `skills` table,
 * and keeps mirroring as the repository moves.
 *
 * ## Which credential a sync uses
 *
 * The sweep runs unattended, so the only identity available is what the
 * source row carries. `deps.readerFor` turns that row into a reader, and
 * `services/skill-source-credential.ts` holds the rule about which owner may
 * use which credential. Read that file before you change anything about the
 * reader here. A source with no resolvable credential reads anonymously,
 * which is what every public repository needs.
 *
 * ## The model
 *
 * The repository is authoritative. A `repo`-origin skill is a mirror with no
 * independent existence, and `syncOnce` is the only thing that writes those
 * rows. A skill somebody wrote in the product (`origin='local'`) is a
 * different kind of thing, and sync never touches one: every write and every
 * delete below is scoped by `source_id` AND `origin='repo'`.
 *
 * ## Change detection is two cheap compares
 *
 * 1. Read the head commit of the tracked ref. If it equals `last_sha`, stop.
 *    That is the whole cost of a poll on a repository nobody touched: ONE
 *    API call. An anonymous read gets 60 calls per hour per IP, so this is
 *    not a micro-optimisation, it is what makes polling affordable.
 * 2. Only when the commit moved: read the tree, and hash a canonical
 *    manifest of the skill files it holds. If the hash equals
 *    `last_manifest_hash`, record the new commit and stop without touching a
 *    single skill row — a commit that changed the README must not churn
 *    every mirrored skill's `updated_at`.
 *
 * The manifest key is the git BLOB sha, which the tree read carries, so
 * compare 2 runs before any file is read. A commit that moved but changed no
 * skill costs two calls in total.
 *
 * Every read after step 1 is pinned to the commit step 1 resolved, so a
 * branch that moves mid-sync cannot produce a manifest that mixes two
 * commits.
 *
 * ## Discovery
 *
 * One recursive tree read finds every `SKILL.md` in the repository, at any
 * depth. `services/skill-discovery.ts` holds the rules about which of those
 * paths is a skill, and its file comment is where they are explained.
 *
 * `subpath` is a filter over that scan, not the place sync is told to look.
 * An empty subdirectory scans the whole repository, which is what makes
 * "import a repository and get its skills" work with nothing else typed.
 * A subdirectory that is not in the tree fails the sync rather than reading
 * as an empty repository — see `SkillRepoSubpathNotFoundError`.
 *
 * The tree read has two limits. GitHub cuts a tree at 100,000 entries and
 * reports the cut; and one request finds the paths, but each skill still
 * costs one request to read. `MAX_SKILL_CANDIDATES` bounds the second, and
 * a repository past it fails with the subdirectory named as the fix.
 *
 * Sync must never mirror from a cut listing, for the reason
 * `SkillRepoListingTruncatedError` gives. So a cut tree falls back to the
 * per-directory walk when the source names a subdirectory to walk, and fails
 * the sync when it does not. `SkillSyncOutcome.discovery` says which of the
 * two ran.
 *
 * ## A delete needs a listing as wide as the one that imported
 *
 * Every path above can produce a listing NARROWER than the one that mirrored
 * the rows, and a narrower listing must not read as "deleted upstream". The
 * three narrowings and what each does instead are in `reconcile`. The rule
 * behind all three: a stale mirror is recoverable on the next sync, and a
 * deleted skill is not.
 *
 * ## A malformed SKILL.md is not a failure
 *
 * It is a per-skill warning on an otherwise successful sync, so the new
 * commit IS recorded and the next poll stops after one call. Treating it as a
 * failure would re-read a file that will never parse, on every retry, for as
 * long as the source exists. The same rule covers a name the owner already
 * holds: the sync warns, and the skill already there is left alone.
 *
 * A transport failure is different. If any `SKILL.md` read fails for a reason
 * other than "not there", the whole sync fails and NOTHING is reconciled —
 * otherwise a GitHub outage would read as "every skill was deleted upstream".
 *
 * "Not there" for a file discovery DID find is not normal either, and it is
 * not a failure: the other skills still mirror. It makes the sync
 * INCOMPLETE, which means the commit and the manifest hash are not recorded,
 * so the next poll reads that file again. Recording a hash over files the
 * sync never read is what would make one lost read permanent.
 *
 * A partial listing fails the sync for the same reason, whether it is a cut
 * tree or a cut directory listing. The entries past the cut cannot be told
 * apart from skills the repository no longer holds, so sync refuses to
 * reconcile from a listing it knows is partial.
 *
 * ## A sync that imports nothing says why
 *
 * "The repository could not be read", "the repository holds no SKILL.md" and
 * "the repository holds skills and they all failed" are three outcomes, and
 * `status: "ok"` with zero counts described all three. Discovery now reports
 * how many candidates it found and how many it would not scan, and
 * `noticeFor` turns that into one message that names what to do, including
 * how many mirrored skills the sync removed. A sync that found no skill is a
 * `warning`, never a silent success.
 *
 * ## The row's report survives a failure
 *
 * `recordFailure` overwrites `last_error` with the transport message, so a
 * source that errors loses whatever the last successful sync reported. The
 * two cheap compares would then hand back a green row on the next unchanged
 * poll, with the skills still missing. So an errored source takes neither
 * compare: it re-reads once and regenerates the report from the repository.
 *
 * ## The sweep
 *
 * `pollOnce` claims due sources with the same single-statement CAS
 * `events/dispatcher.ts` uses: one `UPDATE ... RETURNING` whose OUTER `WHERE`
 * repeats the due conditions. That repeated predicate is the cross-process
 * fence — see the dispatcher's file comment for why the `id IN (subquery)`
 * part cannot fence on its own.
 */
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import {
  isLoadable,
  parseMarkdownArtifact,
  validateSkillFrontmatter,
  BUILTIN_COMMAND_NAMES,
  type SkillSpecViolation,
} from "@valet/engine";
import { isPgUniqueViolation } from "@valet/store-postgres";
import type { AppDb } from "../lib/drizzle.js";
import { skills, skillSources, type SkillRow, type SkillSourceRow } from "../schema/index.js";
import { newSkillId, skillContentSha } from "./skills.js";
import {
  SkillRepoListingTruncatedError,
  SkillRepoNotFoundError,
  SkillRepoSubpathNotFoundError,
  SkillRepoTooManySkillsError,
  SkillRepoTreeTruncatedError,
  type SkillRepoHead,
  type SkillRepoReader,
} from "./skill-repo-reader.js";
import {
  discoverFromTree,
  resolveNameCollisions,
  treeHoldsSubpath,
  MAX_SKILL_CANDIDATES,
  SKILL_FILE,
  PROMPTS_DIR,
  type SkillCandidate,
} from "./skill-discovery.js";

/** How long a healthy source waits before its next poll. An anonymous read
 * gets 60 requests per hour per IP, and an unchanged source costs one, so
 * this budgets four calls per hour per source. An authenticated read has a
 * far larger budget, and keeps this interval anyway: the interval is also
 * how fresh a mirror is, and one number is easier to reason about than two. */
export const SYNC_INTERVAL_MS = 15 * 60_000;
/** Retry backoff per consecutive failure. A failure past the last entry
 * repeats the last entry: a source is a standing subscription, not a
 * one-shot delivery, so it keeps retrying at the slowest rung instead of
 * dying the way `event_deliveries` does. */
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000];
const POLL_MS = 60_000;
const BATCH = 10;
/** How long a claimed source stays invisible to other sweeps. Generous
 * enough for a large repository's file reads. */
const CLAIM_LEASE_MS = 5 * 60_000;
const MAX_STATUS_CHARS = 2_000;

/** One skill file as the repository holds it. `name` comes from the PATH —
 * the directory name for a skill, the file name for a prompt — which is the
 * spec's skill name and the only identity available before the frontmatter
 * parses. */
export interface SkillManifestEntry {
  name: string;
  path: string;
  /** Git blob sha. Named for what it is, because `SkillRow.contentSha` is a
   * different hash over a different thing — the skill BODY, without the
   * frontmatter. A frontmatter-only edit moves this and not that. */
  blobSha: string;
}

/** How discovery found the skill files. `directory-walk` says the tree was
 * cut and sync fell back to listing the configured subdirectory, which finds
 * strictly less: one level, one directory. */
export type SkillDiscoveryMode = "tree" | "directory-walk";

export interface SkillSyncOutcome {
  /** `ok` — synced with nothing to report. `warning` — synced, but at least
   * one skill was skipped, or none was found. `error` — nothing was
   * reconciled. */
  status: "ok" | "warning" | "error";
  /** False when the poll stopped at one of the two compares. */
  changed: boolean;
  headSha: string | null;
  imported: number;
  updated: number;
  deleted: number;
  warnings: string[];
  /** Why a sync imported nothing, when that needs saying. Distinct from
   * `warnings`, which is one line per SKIPPED skill: this line is about the
   * repository, and it is what separates "we read it and it holds no
   * SKILL.md" from "we could not read it". */
  notice: string | null;
  /** Skill files discovery found, before names collided and before any file
   * was parsed. Zero says the repository holds no skill. */
  discovered: number;
  /** Skill files discovery found under a directory it does not scan. */
  excluded: number;
  /** Null when the poll stopped at the head-commit compare and discovery
   * never ran. */
  discovery: SkillDiscoveryMode | null;
  error: string | null;
}

export interface SkillSyncDeps {
  db: AppDb;
  /** The reader used when `readerFor` is not supplied. Anonymous in every
   * caller that ships, which is what a public repository needs. */
  reader: SkillRepoReader;
  /** Builds the reader for ONE source, so a private repository is read with
   * the credential its owner holds. `services/skill-source-credential.ts`
   * supplies the only implementation, and it is where the rule about which
   * credential belongs to which owner lives. Without it every sync uses
   * `reader`. */
  readerFor?: (source: SkillSourceRow) => Promise<SkillRepoReader>;
  /** Injected clock, for tests that need a deterministic schedule. */
  now?: () => number;
}

/**
 * Leases the due sources by moving `next_attempt_at` forward in the same
 * statement that selects them, and returns what it claimed.
 *
 * The due conditions are repeated on the OUTER update — that is the
 * cross-process fence, exactly as in `events/dispatcher.ts`, whose file
 * comment explains why the `id IN (subquery)` part cannot fence on its own:
 * a raced loser's EvalPlanQual recheck runs against the winner's committed
 * row, where `next_attempt_at` has already moved past `now`, so the recheck
 * fails and the loser skips the row. A crash mid-sync leaves the source
 * claimed until the lease lapses, and it becomes due again on its own.
 *
 * Exported so the fence is testable without reaching into the service.
 */
export async function claimDueSkillSources(
  db: AppDb,
  now: number,
  batch: number = BATCH,
  leaseMs: number = CLAIM_LEASE_MS,
): Promise<string[]> {
  const due = db
    .select({ id: skillSources.id })
    .from(skillSources)
    .where(and(eq(skillSources.enabled, true), lte(skillSources.nextAttemptAt, now)))
    .orderBy(asc(skillSources.nextAttemptAt))
    .limit(batch);
  const claimed = await db
    .update(skillSources)
    .set({ nextAttemptAt: now + leaseMs })
    .where(
      and(
        inArray(skillSources.id, due),
        eq(skillSources.enabled, true),
        lte(skillSources.nextAttemptAt, now),
      ),
    )
    .returning({ id: skillSources.id });
  return claimed.map((row) => row.id);
}

export interface SkillManifestLists {
  /** Entries from a skill directory (`<dir>/<name>/SKILL.md`). */
  skillEntries: SkillManifestEntry[];
  /** Entries from a `prompts/` directory (`<dir>/prompts/<name>.md`). */
  promptEntries: SkillManifestEntry[];
}

/**
 * Hash over the canonical manifest. Skill entries and prompt entries are each
 * sorted by name, then concatenated (skills first, prompts second), and
 * rendered as compact JSON so the hash depends on content, not listing order.
 *
 * The per-file key is the git blob sha, so this hash can be computed from a
 * tree listing with no file read. A tree read and a directory walk produce
 * the same key for the same file, so a source that falls back between the two
 * does not churn.
 */
export function skillManifestHash(lists: SkillManifestLists): string {
  const canonical = [
    ...canonicalEntries(lists.skillEntries),
    ...canonicalEntries(lists.promptEntries),
  ];
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function canonicalEntries(entries: SkillManifestEntry[]): SkillManifestEntry[] {
  return [...entries]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({ name: e.name, path: e.path, blobSha: e.blobSha }));
}

export class SkillSyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly deps: SkillSyncDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.pollOnce(), POLL_MS);
    // Immediate pass so a source added before the last shutdown does not
    // wait a full interval after boot.
    void this.pollOnce();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.draining) await new Promise((r) => setTimeout(r, 25));
  }

  /** One sweep pass over the due sources. Never throws. */
  async pollOnce(): Promise<void> {
    if (this.stopped || this.draining) return;
    this.draining = true;
    try {
      for (const id of await claimDueSkillSources(this.deps.db, this.now())) {
        await this.syncOnce(id).catch((err) => console.error(`skill sync ${id}:`, err));
      }
    } catch (err) {
      console.error("skill sync: poll failed:", err);
    } finally {
      this.draining = false;
    }
  }

  /**
   * Syncs one source. The ONLY sync implementation: the sweep and the "Sync
   * now" route both land here, so there is one set of rules about what a sync
   * does. Returns null when the source row is gone.
   */
  async syncOnce(sourceId: string): Promise<SkillSyncOutcome | null> {
    const { db } = this.deps;
    const [source] = await db.select().from(skillSources).where(eq(skillSources.id, sourceId)).limit(1);
    if (!source) return null;

    try {
      return await this.run(source);
    } catch (err) {
      return this.recordFailure(source, err);
    }
  }

  private async run(source: SkillSourceRow): Promise<SkillSyncOutcome> {
    // The credential is resolved ONCE per sync, not once per request, so
    // every read of one commit goes out under the same identity.
    const reader = this.deps.readerFor
      ? await this.deps.readerFor(source)
      : this.deps.reader;

    // Both compares below stop this poll and leave the row's report where it
    // is. That is only sound when the row's report describes a sync that
    // finished. After a failure it does not: `recordFailure` overwrites
    // `last_error` with the transport message and destroys whatever the last
    // successful sync reported, so a source that was warning about a broken
    // skill would come back green on the first unchanged poll after the
    // failure, with the skill still missing. So an errored source re-reads.
    // It costs one tree read plus the file reads, once, and it regenerates
    // the report from the repository instead of from the previous row.
    const reportIsStale = source.status === "error";

    // Compare 1 — the head commit.
    const head = await reader.head(source.repoFullName, source.ref);
    if (head.sha === source.lastSha && !reportIsStale) {
      // Nothing was re-read, so this poll learned nothing that could clear
      // what the last one reported. `carryWarning` keeps that report on the
      // row; without it a source whose skills are all broken flips to a
      // silent "ok" fifteen minutes later.
      return this.recordSuccess(source, {
        headSha: head.sha,
        manifestHash: source.lastManifestHash,
        changed: false,
        complete: true,
        carryWarning: true,
      });
    }

    // Everything below reads at `head`, never at the moving ref.
    const manifest = await this.readManifest(source, head, reader);

    // Compare 2 — the skills that commit holds. The manifest keys are blob
    // shas from the tree read, so this runs before any file is read.
    const manifestHash = skillManifestHash({
      skillEntries: manifest.skillEntries,
      promptEntries: manifest.promptEntries,
    });
    if (manifestHash === source.lastManifestHash && !reportIsStale) {
      // No file was read, so no per-skill warning can be regenerated here.
      // The discovery warnings can: they are facts about paths and names,
      // and discovery just ran. `carryWarning` covers the rest.
      return this.recordSuccess(source, {
        headSha: head.sha,
        manifestHash,
        changed: false,
        complete: true,
        carryWarning: true,
        discovered: manifest.discovered,
        excluded: manifest.excludedCandidates.length,
        discovery: manifest.discovery,
        warnings: manifest.warnings,
        notice: noticeFor(source, { manifest, deleted: 0, keptStale: [] }),
      });
    }

    const allEntries = [...manifest.skillEntries, ...manifest.promptEntries];
    const read = await this.readContents(source, head.sha, reader, allEntries, manifest.text);
    const applied = await this.reconcile(source, manifest, allEntries, read.text);
    return this.recordSuccess(source, {
      headSha: head.sha,
      manifestHash,
      changed: applied.imported + applied.updated + applied.deleted > 0,
      // A file discovery found and the sync could not read leaves the
      // manifest hash describing files nobody read. Recording it would make
      // compare 2 skip the whole commit forever, so this sync is incomplete
      // and records neither the commit nor the hash.
      complete: read.unread.length === 0,
      discovered: manifest.discovered,
      excluded: manifest.excludedCandidates.length,
      discovery: manifest.discovery,
      imported: applied.imported,
      updated: applied.updated,
      deleted: applied.deleted,
      warnings: [...manifest.warnings, ...read.warnings, ...applied.warnings],
      notice: noticeFor(source, {
        manifest,
        deleted: applied.deleted,
        keptStale: applied.keptStale,
      }),
    });
  }

  /**
   * Reads the `SKILL.md` of every entry the manifest holds, and returns the
   * content keyed by FILE PATH — never by name, so a skill directory and a
   * same-named prompt file cannot overwrite each other.
   *
   * `known` carries what the directory walk already read: that path learns a
   * file's blob sha by reading the file, so its text is free and must not be
   * fetched twice.
   *
   * A read fault propagates and fails the whole sync. Only "the file is not
   * there" is a normal answer, and it means the ref moved out from under a
   * pinned read, or the path is one the contents endpoint addresses
   * differently. That entry is dropped and its row is kept.
   *
   * A drop is REPORTED, and it makes the sync incomplete. Discovery said the
   * file is there, so a sync that could not read it did not read the commit
   * it is about to record. `unread` is what tells the caller to record
   * neither the commit nor the manifest hash, which is what makes the next
   * poll try the file again. Without that, one 404 in the window between the
   * tree read and the file reads hides a skill until somebody edits it.
   */
  private async readContents(
    source: SkillSourceRow,
    headSha: string,
    reader: SkillRepoReader,
    entries: SkillManifestEntry[],
    known: Map<string, string>,
  ): Promise<{ text: Map<string, string>; unread: string[]; warnings: string[] }> {
    const text = new Map(known);
    const unread: string[] = [];
    for (const entry of entries) {
      if (text.has(entry.path)) continue;
      const file = await reader.readFile(source.repoFullName, entry.path, headSha);
      if (file === null) {
        unread.push(entry.path);
        continue;
      }
      text.set(entry.path, file.text);
    }
    const warnings = unread.map(
      (path) =>
        `${path} was in the repository listing and could not be read, so this skill was not imported. Valet reads it again on the next sync. If it stays, check that the path is a file and not a symbolic link.`,
    );
    return { text, unread, warnings };
  }

  /**
   * Finds the skill files the commit holds. One recursive tree read serves
   * every source; the per-directory walk below runs only when GitHub cut that
   * tree AND the source names a subdirectory to walk instead.
   *
   * The reader is passed in rather than read from `deps`, so every read in
   * one sync carries the credential `run` resolved for that source.
   */
  private async readManifest(
    source: SkillSourceRow,
    head: SkillRepoHead,
    reader: SkillRepoReader,
  ): Promise<SkillManifest> {
    const tree = await reader.listTree(source.repoFullName, head.treeSha);
    if (!tree.truncated) {
      // The subdirectory has to exist before its emptiness means anything.
      // See `SkillRepoSubpathNotFoundError`: without this test, a renamed or
      // misspelled subdirectory reads as "the repository holds no skill" and
      // reconcile deletes every mirrored row.
      if (!treeHoldsSubpath(tree.entries, source.subpath)) {
        throw new SkillRepoSubpathNotFoundError(source.repoFullName, source.subpath, source.ref);
      }
      const found = discoverFromTree(tree.entries, source.subpath);
      // One request found the paths; the contents are still one request each.
      // See `MAX_SKILL_CANDIDATES`.
      if (found.discovered > MAX_SKILL_CANDIDATES) {
        throw new SkillRepoTooManySkillsError(
          source.repoFullName,
          found.discovered,
          MAX_SKILL_CANDIDATES,
        );
      }
      return manifestFromCandidates(found, "tree");
    }
    // A cut tree must never reconcile, for the reason the truncation errors
    // carry. With a subdirectory there is somewhere smaller to look, and the
    // contents endpoint has its own cut guard; without one there is not.
    if (source.subpath.length === 0) {
      throw new SkillRepoTreeTruncatedError(source.repoFullName);
    }
    return this.walkDirectory(source, head.sha, reader);
  }

  /**
   * The pre-tree discovery path: list the configured subdirectory, then read
   * `<subdirectory>/<entry>/SKILL.md` under each directory in it, then list
   * `<subdirectory>/prompts`.
   *
   * It finds strictly less than the tree read — one level, one directory —
   * and costs one request per candidate directory. It stays for one case: a
   * repository with more than 100,000 files, where the tree read is cut.
   */
  private async walkDirectory(
    source: SkillSourceRow,
    headSha: string,
    reader: SkillRepoReader,
  ): Promise<SkillManifest> {
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

    // The same candidate cap as the tree path. The listing this walk reads
    // is capped at `MAX_DIRECTORY_ENTRIES`, which is higher, and the cost
    // being bounded here is the FILE reads, which are the same cost on
    // either path. One limit is easier to reason about than two.
    if (candidates.length > MAX_SKILL_CANDIDATES) {
      throw new SkillRepoTooManySkillsError(
        source.repoFullName,
        candidates.length,
        MAX_SKILL_CANDIDATES,
      );
    }

    // The same collision rule as the tree path, so the two paths never
    // disagree about which of two same-named files is a skill.
    const resolved = resolveNameCollisions(candidates);
    return {
      ...manifestFromCandidates(
        { ...resolved, discovered: candidates.length, excludedCandidates: [] },
        "directory-walk",
      ),
      text,
    };
  }

  /**
   * Brings this source's mirrored rows in line with `entries`.
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
  private async reconcile(
    source: SkillSourceRow,
    manifest: SkillManifest,
    entries: SkillManifestEntry[],
    text: Map<string, string>,
  ): Promise<{
    imported: number;
    updated: number;
    deleted: number;
    /** Rows this pass would have deleted and kept instead, by name. */
    keptStale: string[];
    warnings: string[];
  }> {
    const { db } = this.deps;
    const { promptNames, reservedNames } = manifest;
    const existing = await db
      .select()
      .from(skills)
      .where(and(eq(skills.sourceId, source.id), eq(skills.origin, "repo")));
    const byName = new Map(existing.map((row) => [row.name, row]));
    const upstream = new Set([...entries.map((e) => e.name), ...reservedNames]);

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
    for (const candidate of manifest.excludedCandidates) {
      if (!byName.has(candidate.name) || upstream.has(candidate.name)) continue;
      upstream.add(candidate.name);
      warnings.push(
        `${candidate.name}: ${candidate.path} sits under a directory Valet does not scan, so this skill was not re-read. The skill already here is unchanged. Move the file out of that directory, or set the subdirectory that holds it.`,
      );
    }

    for (const entry of entries) {
      // Content is keyed by PATH to prevent a same-named skill directory and
      // prompt file from silently overwriting each other in the map.
      const raw = text.get(entry.path);
      if (raw === undefined) continue;
      const isPrompt = promptNames.has(entry.name);
      const parsed = isPrompt
        ? parsePromptFile(raw, entry.name)
        : parseSkillFile(raw, entry.name);
      if (parsed.violations.length > 0) {
        warnings.push(`${entry.name}: ${parsed.violations.map((v) => v.message).join(" ")}`);
        // An advisory violation is reported but does not stop the mirror.
        // Nobody here can edit the upstream repository, so refusing the
        // skill would only make the corpus incomplete. An error means the
        // skill is broken or unfindable, and that one is skipped.
        if (!isLoadable(parsed.violations)) continue;
      }
      const row = byName.get(entry.name);
      if (row === undefined) {
        const wrote = await this.insertMirror(source, entry, parsed);
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
      if (await this.updateMirror(row, entry, parsed)) updated += 1;
    }

    const stale = existing.filter((row) => !upstream.has(row.name));
    // The directory walk is narrower than the tree read that mirrored these
    // rows, so its absences prove nothing. A stale mirror is recoverable —
    // the next sync on a tree that fits deletes what is really gone — and a
    // deleted skill is not.
    if (manifest.discovery === "directory-walk") {
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

  /** Returns false when the owner already holds that skill name. */
  private async insertMirror(
    source: SkillSourceRow,
    entry: SkillManifestEntry,
    parsed: ParsedSkillFile,
  ): Promise<boolean> {
    const now = this.now();
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
      await this.deps.db.insert(skills).values(row);
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
  private async updateMirror(
    row: SkillRow,
    entry: SkillManifestEntry,
    parsed: ParsedSkillFile,
  ): Promise<boolean> {
    const contentSha = skillContentSha(parsed.body);
    const unchanged =
      row.contentSha === contentSha &&
      row.description === parsed.description &&
      row.upstreamPath === entry.path;
    if (unchanged) return false;
    await this.deps.db
      .update(skills)
      .set({
        description: parsed.description,
        content: parsed.body,
        frontmatter: parsed.frontmatter,
        contentSha,
        upstreamPath: entry.path,
        updatedAt: this.now(),
      })
      .where(eq(skills.id, row.id));
    return true;
  }

  private async recordSuccess(
    source: SkillSourceRow,
    result: {
      headSha: string;
      manifestHash: string | null;
      changed: boolean;
      imported?: number;
      updated?: number;
      deleted?: number;
      warnings?: string[];
      notice?: string | null;
      discovered?: number;
      excluded?: number;
      discovery?: SkillDiscoveryMode | null;
      /**
       * False when a file discovery found could not be read. The two cheap
       * compares key off `last_sha` and `last_manifest_hash`, so recording
       * either after a partial read tells the next poll that this commit is
       * already mirrored. It is not. An incomplete sync therefore leaves
       * both columns where they were, and the next poll reads the commit
       * again.
       */
      complete: boolean;
      /** Set when this poll stopped at a compare and read no skill file. It
       * learned nothing that could clear the last poll's report, so that
       * report stays on the row. */
      carryWarning?: boolean;
    },
  ): Promise<SkillSyncOutcome> {
    const warnings = result.warnings ?? [];
    const notice = result.notice ?? null;
    const now = this.now();
    // A message about the repository comes first, then one line per skipped
    // skill. `last_error` is the one column the panel prints.
    const lines = [...(notice === null ? [] : [notice]), ...warnings];
    const carried = result.carryWarning === true && source.status === "warning";
    const status = lines.length > 0 || carried ? "warning" : "ok";
    const message =
      lines.length > 0 ? lines.join("\n").slice(0, MAX_STATUS_CHARS) : carried ? source.lastError : null;
    await this.deps.db
      .update(skillSources)
      .set({
        status,
        attempts: 0,
        nextAttemptAt: now + SYNC_INTERVAL_MS,
        lastSha: result.complete ? result.headSha : source.lastSha,
        lastManifestHash: result.complete ? result.manifestHash : source.lastManifestHash,
        lastSyncedAt: now,
        lastError: message,
        updatedAt: now,
      })
      .where(eq(skillSources.id, source.id));

    return {
      status,
      changed: result.changed,
      headSha: result.headSha,
      imported: result.imported ?? 0,
      updated: result.updated ?? 0,
      deleted: result.deleted ?? 0,
      warnings,
      notice,
      discovered: result.discovered ?? 0,
      excluded: result.excluded ?? 0,
      discovery: result.discovery ?? null,
      error: null,
    };
  }

  /** Records a failed sync and schedules the retry. `last_sha` and
   * `last_manifest_hash` are left alone, so the next attempt re-reads. */
  private async recordFailure(source: SkillSourceRow, err: unknown): Promise<SkillSyncOutcome> {
    const now = this.now();
    const attempts = source.attempts + 1;
    const backoff = BACKOFF_MS[attempts - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1] ?? POLL_MS;
    const message = err instanceof Error ? err.message : String(err);
    await this.deps.db
      .update(skillSources)
      .set({
        status: "error",
        attempts,
        nextAttemptAt: now + backoff,
        lastError: message.slice(0, MAX_STATUS_CHARS),
        updatedAt: now,
      })
      .where(eq(skillSources.id, source.id));

    // A repository or a subdirectory that vanished is worth a log line: it
    // does not clear on its own, and it holds a mirror still. A transient
    // GitHub fault is already visible on the source row.
    if (err instanceof SkillRepoNotFoundError || err instanceof SkillRepoSubpathNotFoundError) {
      console.warn(`skill sync ${source.id}: ${message}`);
    }
    return {
      status: "error",
      changed: false,
      headSha: null,
      imported: 0,
      updated: 0,
      deleted: 0,
      warnings: [],
      notice: null,
      discovered: 0,
      excluded: 0,
      discovery: null,
      error: message,
    };
  }
}

/** What one commit's discovery produced, before any file is read. */
interface SkillManifest {
  skillEntries: SkillManifestEntry[];
  /** Entries from a `prompts/` directory (`<dir>/prompts/<name>.md`). */
  promptEntries: SkillManifestEntry[];
  /** Names that came from `prompts/`, so reconcile parses them differently. */
  promptNames: Set<string>;
  /** Names a candidate holds that discovery would not import. Still upstream,
   * so reconcile keeps the rows that hold them. */
  reservedNames: Set<string>;
  /** One line per candidate found and not imported. */
  warnings: string[];
  /** Content already read, keyed by FILE PATH. Empty after a tree read; the
   * directory walk fills it, because it reads a file to learn its blob sha. */
  text: Map<string, string>;
  discovered: number;
  /** Files that are `SKILL.md` or `prompts/*.md` and sit under a directory
   * the scan skips. Carried as candidates, not a count, so reconcile can
   * test their names against the rows this source mirrors. */
  excludedCandidates: SkillCandidate[];
  discovery: SkillDiscoveryMode;
}

/** Splits discovery's accepted candidates into the two lists reconcile takes.
 * Both discovery paths end here, so both produce the same shape. */
function manifestFromCandidates(
  found: {
    accepted: SkillCandidate[];
    reservedNames: Set<string>;
    warnings: string[];
    discovered: number;
    excludedCandidates: SkillCandidate[];
  },
  discovery: SkillDiscoveryMode,
): SkillManifest {
  const skillEntries: SkillManifestEntry[] = [];
  const promptEntries: SkillManifestEntry[] = [];
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
  return {
    skillEntries,
    promptEntries,
    promptNames,
    reservedNames: found.reservedNames,
    warnings: found.warnings,
    text: new Map(),
    discovered: found.discovered,
    excludedCandidates: found.excludedCandidates,
    discovery,
  };
}

/**
 * What this sync needs to say about the REPOSITORY, as distinct from
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
function noticeFor(
  source: SkillSourceRow,
  result: { manifest: SkillManifest; deleted: number; keptStale: string[] },
): string | null {
  const { manifest } = result;
  const where = `${source.repoFullName} on ${source.ref.length > 0 ? source.ref : "the default branch"}`;
  const lines: string[] = [];

  if (manifest.discovery === "directory-walk") {
    const scanned = source.subpath.length > 0 ? source.subpath : "the repository root";
    const kept =
      result.keptStale.length === 0
        ? ""
        : ` Valet kept ${result.keptStale.length} mirrored ${result.keptStale.length === 1 ? "skill" : "skills"} this scan did not reach: ${result.keptStale.join(", ")}.`;
    lines.push(
      `${where} holds more files than Valet can read in one listing, so Valet read only ${scanned}, one level deep. A skill in a deeper directory is not imported, and no skill is deleted.${kept} Remove this repository, then import the /tree/ URL of the directory that holds the skills.`,
    );
  }

  if (manifest.discovered === 0) {
    const removed =
      result.deleted === 0
        ? ""
        : ` Valet removed the ${result.deleted} ${result.deleted === 1 ? "skill" : "skills"} it had mirrored from this source.`;
    const excluded = manifest.excludedCandidates.length;
    if (excluded > 0) {
      lines.push(
        `Valet found ${excluded} ${SKILL_FILE} ${excluded === 1 ? "file" : "files"} in ${where}, all under directories it does not scan: dependencies, build output, tests, and downloaded agent plugins.${removed} Set the subdirectory that holds the skills, by importing its /tree/ URL.`,
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
    description: typeof parsed.frontmatter.description === "string" ? parsed.frontmatter.description : "",
    body: parsed.body.trimStart(),
    frontmatter,
    violations: [...nameViolations, ...invocationViolations],
  };
}

/** Joins path parts, dropping the empty ones a root-level source produces. */
function joinPath(...parts: string[]): string {
  return parts.filter((part) => part.length > 0).join("/");
}
