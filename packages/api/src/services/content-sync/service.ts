/**
 * Repository content sync — mirrors what a GitHub repository holds into
 * Valet's own tables, and keeps mirroring as the repository moves.
 *
 * This file is the rail. It knows about commits, trees, credentials, and
 * retries; it knows nothing about `SKILL.md` or about any table a mirror
 * lands in. Every per-kind rule lives behind `ContentCollector`
 * (`content-sync/collector.ts`), and `content-sync/skill-collector.ts` is the
 * collector that ships.
 *
 * ## Which credential a sync uses
 *
 * The sweep runs unattended, so the only identity available is what the
 * source row carries. `deps.readerFor` turns that row into a reader, and
 * `services/content-source-credential.ts` holds the rule about which owner
 * may use which credential. Read that file before you change anything about
 * the reader here. A source with no resolvable credential reads anonymously,
 * which is what every public repository needs.
 *
 * ## The model
 *
 * The repository is authoritative. A `repo`-origin row is a mirror with no
 * independent existence, and `syncOnce` is the only thing that writes those
 * rows. A row somebody wrote in the product (`origin='local'`) is a different
 * kind of thing, and sync never touches one: every write and every delete a
 * collector makes is scoped by `source_id` AND `origin='repo'`.
 *
 * ## Change detection is two cheap compares
 *
 * 1. Read the head commit of the tracked ref. If it equals `last_sha` AND
 *    the source last synced under the current discovery rules, stop. That is
 *    the whole cost of a poll on a repository nobody touched: ONE API call.
 *    An anonymous read gets 60 calls per hour per IP, so this is not a
 *    micro-optimisation, it is what makes polling affordable. The rules half
 *    of the test is what lets a release change which paths a collector claims
 *    without waiting for an unrelated commit — see `DISCOVERY_RULES_VERSION`
 *    in `content-sync/collector.ts`.
 * 2. Only when the commit moved: read the tree, ask every enabled collector
 *    to discover over it, and hash ONE manifest over the union of what they
 *    found. If the hash equals `last_manifest_hash`, record the new commit
 *    and stop without touching a single mirrored row — a commit that changed
 *    the README must not churn every mirrored row's `updated_at`.
 *
 * The manifest key is the git BLOB sha, which the tree read carries, so
 * compare 2 runs before any file is read. A commit that moved and changed
 * nothing tracked costs two calls in total.
 *
 * Every read after step 1 is pinned to the commit step 1 resolved, so a
 * branch that moves mid-sync cannot produce a manifest that mixes two
 * commits.
 *
 * ## Discovery
 *
 * One recursive tree read serves every collector, so a repository tracked for
 * two kinds still costs one tree read. `subpath` is a filter over that scan,
 * not the place the sync is told to look: an empty subdirectory scans the
 * whole repository. A subdirectory that is not in the tree fails the sync
 * rather than reading as an empty repository — see
 * `SkillRepoSubpathNotFoundError`.
 *
 * The tree read has two limits. GitHub cuts a tree at 100,000 entries and
 * reports the cut; and one request finds the paths, but each candidate still
 * costs one request to read. `MAX_SKILL_CANDIDATES` bounds the second across
 * every kind together, and a repository past it fails with the subdirectory
 * named as the fix.
 *
 * Sync must never mirror from a cut listing, for the reason
 * `SkillRepoListingTruncatedError` gives. So a cut tree falls back to each
 * collector's per-directory walk when the source names a subdirectory to
 * walk, and fails the sync when it does not. `ContentSyncOutcome.discovery`
 * says which of the two ran.
 *
 * ## A delete needs a listing as wide as the one that imported
 *
 * Every path above can produce a listing NARROWER than the one that mirrored
 * the rows, and a narrower listing must not read as "deleted upstream". The
 * rule behind that: a stale mirror is recoverable on the next sync, and a
 * deleted row is not. `CollectorReconcileContext.discovery` is how a
 * collector learns that this scan was the narrow one.
 *
 * ## A malformed file is not a failure
 *
 * It is a per-file warning on an otherwise successful sync, so the new commit
 * IS recorded and the next poll stops after one call. Treating it as a
 * failure would re-read a file that will never parse, on every retry, for as
 * long as the source exists.
 *
 * A transport failure is different. If any file read fails for a reason other
 * than "not there", the whole sync fails and NOTHING is reconciled —
 * otherwise a GitHub outage would read as "everything was deleted upstream".
 *
 * "Not there" for a file discovery DID find is not normal either, and it is
 * not a failure: the other files still mirror. It makes the sync INCOMPLETE,
 * which means the commit and the manifest hash are not recorded, so the next
 * poll reads that file again. Recording a hash over files the sync never read
 * is what would make one lost read permanent.
 *
 * A partial listing fails the sync for the same reason, whether it is a cut
 * tree or a cut directory listing. The entries past the cut cannot be told
 * apart from files the repository no longer holds, so sync refuses to
 * reconcile from a listing it knows is partial.
 *
 * ## A sync that imports nothing says why
 *
 * "The repository could not be read", "the repository holds nothing to
 * mirror" and "the repository holds files and they all failed" are three
 * outcomes, and `status: "ok"` with zero counts described all three.
 * Discovery reports how many candidates it found and how many it would not
 * scan, and each collector's `notice` turns that into one message that names
 * what to do. A sync that found nothing is a `warning`, never a silent
 * success.
 *
 * ## The row's report survives a failure
 *
 * `recordFailure` overwrites `last_error` with the transport message, so a
 * source that errors loses whatever the last successful sync reported. The
 * two cheap compares would then hand back a green row on the next unchanged
 * poll, with the files still missing. So an errored source takes neither
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
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import type { AppDb } from "../../lib/drizzle.js";
import { contentSources, type ContentSourceRow } from "../../schema/index.js";
import {
  SkillRepoNotFoundError,
  SkillRepoSubpathNotFoundError,
  SkillRepoTooManySkillsError,
  SkillRepoTreeTruncatedError,
  type SkillRepoHead,
  type SkillRepoReader,
} from "../skill-repo-reader.js";
import { treeHoldsSubpath, MAX_SKILL_CANDIDATES } from "../skill-discovery.js";
import {
  contentManifestHash,
  DISCOVERY_RULES_VERSION,
  type CollectorPass,
  type CollectorReconcileResult,
  type ContentCollector,
  type ContentDiscoveryMode,
} from "./collector.js";
import { SkillCollector } from "./skill-collector.js";

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

export interface ContentSyncOutcome {
  /** `ok` — synced with nothing to report. `warning` — synced, but at least
   * one file was skipped, or none was found. `error` — nothing was
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
   * `warnings`, which is one line per SKIPPED file: this line is about the
   * repository, and it is what separates "we read it and it holds nothing to
   * mirror" from "we could not read it". */
  notice: string | null;
  /** Files discovery found, across every enabled kind, before names collided
   * and before any file was parsed. Zero says the repository holds nothing
   * this source collects. */
  discovered: number;
  /** Files discovery found under a directory it does not scan. */
  excluded: number;
  /** Null when the poll stopped at the head-commit compare and discovery
   * never ran. */
  discovery: ContentDiscoveryMode | null;
  error: string | null;
}

export interface ContentSyncServiceDeps {
  db: AppDb;
  /** The reader used when `readerFor` is not supplied. Anonymous in every
   * caller that ships, which is what a public repository needs. */
  reader: SkillRepoReader;
  /** Builds the reader for ONE source, so a private repository is read with
   * the credential its owner holds. `services/content-source-credential.ts`
   * supplies the only implementation, and it is where the rule about which
   * credential belongs to which owner lives. Without it every sync uses
   * `reader`. */
  readerFor?: (source: ContentSourceRow) => Promise<SkillRepoReader>;
  /** The collectors this deployment can run. A source runs the subset its
   * `kinds` column names. Defaults to the skills collector alone. */
  collectors?: ContentCollector[];
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
export async function claimDueContentSources(
  db: AppDb,
  now: number,
  batch: number = BATCH,
  leaseMs: number = CLAIM_LEASE_MS,
): Promise<string[]> {
  const due = db
    .select({ id: contentSources.id })
    .from(contentSources)
    .where(and(eq(contentSources.enabled, true), lte(contentSources.nextAttemptAt, now)))
    .orderBy(asc(contentSources.nextAttemptAt))
    .limit(batch);
  const claimed = await db
    .update(contentSources)
    .set({ nextAttemptAt: now + leaseMs })
    .where(
      and(
        inArray(contentSources.id, due),
        eq(contentSources.enabled, true),
        lte(contentSources.nextAttemptAt, now),
      ),
    )
    .returning({ id: contentSources.id });
  return claimed.map((row) => row.id);
}

/** Every collector's work for one commit, with the discovery path that found
 * it. The two travel together because a collector's reconcile has to know
 * whether this scan was the narrow one. */
interface SyncScan {
  passes: CollectorPass[];
  discovery: ContentDiscoveryMode;
}

/** One pass and what its OWN reconcile wrote. The two travel together so
 * that one collector's counts cannot reach another collector's notice: a
 * sweep-wide `deleted` would report the workflows a sync removed as skills
 * the sync removed. */
interface AppliedPass {
  pass: CollectorPass;
  result: CollectorReconcileResult;
}

/** What a pass wrote when no reconcile ran, for a poll that stopped at a
 * compare. Read-only: a `notice` reads this and never writes it. */
const NOTHING_RECONCILED: CollectorReconcileResult = {
  imported: 0,
  updated: 0,
  deleted: 0,
  keptStale: [],
  warnings: [],
};

export class ContentSyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private stopped = false;
  private readonly now: () => number;
  private readonly collectors: ContentCollector[];

  constructor(private readonly deps: ContentSyncServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.collectors = deps.collectors ?? [new SkillCollector()];
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
      for (const id of await claimDueContentSources(this.deps.db, this.now())) {
        await this.syncOnce(id).catch((err) => console.error(`content sync ${id}:`, err));
      }
    } catch (err) {
      console.error("content sync: poll failed:", err);
    } finally {
      this.draining = false;
    }
  }

  /**
   * Syncs one source. The ONLY sync implementation: the sweep and the "Sync
   * now" route both land here, so there is one set of rules about what a sync
   * does. Returns null when the source row is gone.
   */
  async syncOnce(sourceId: string): Promise<ContentSyncOutcome | null> {
    const { db } = this.deps;
    const [source] = await db
      .select()
      .from(contentSources)
      .where(eq(contentSources.id, sourceId))
      .limit(1);
    if (!source) return null;

    try {
      return await this.run(source);
    } catch (err) {
      return this.recordFailure(source, err);
    }
  }

  /** The collectors this source's `kinds` column enables, in the order the
   * deployment registered them. That order fixes the manifest hash, so it
   * must not depend on the row. */
  private collectorsFor(source: ContentSourceRow): ContentCollector[] {
    return this.collectors.filter((collector) => source.kinds.includes(collector.kind));
  }

  private async run(source: ContentSourceRow): Promise<ContentSyncOutcome> {
    // The credential is resolved ONCE per sync, not once per request, so
    // every read of one commit goes out under the same identity.
    const reader = this.deps.readerFor ? await this.deps.readerFor(source) : this.deps.reader;

    // Both compares below stop this poll and leave the row's report where it
    // is. That is only sound when the row's report describes a sync that
    // finished. After a failure it does not: `recordFailure` overwrites
    // `last_error` with the transport message and destroys whatever the last
    // successful sync reported, so a source that was warning about a broken
    // file would come back green on the first unchanged poll after the
    // failure, with the file still missing. So an errored source re-reads.
    // It costs one tree read plus the file reads, once, and it regenerates
    // the report from the repository instead of from the previous row.
    const reportIsStale = source.status === "error";

    // A release can change which paths a collector claims. The head commit
    // then says nothing about whether this source is up to date: the commit
    // has not moved, and the rules that read it have. Such a source takes no
    // short-circuit, re-scans once, and records the version it ran under —
    // see `DISCOVERY_RULES_VERSION`.
    const rulesAreStale = source.discoveryRulesVersion !== DISCOVERY_RULES_VERSION;

    // Compare 1 — the head commit.
    const head = await reader.head(source.repoFullName, source.ref);
    if (head.sha === source.lastSha && !reportIsStale && !rulesAreStale) {
      // Nothing was re-read, so this poll learned nothing that could clear
      // what the last one reported. `carryWarning` keeps that report on the
      // row; without it a source whose files are all broken flips to a
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
    const scan = await this.readManifest(source, head, reader);

    // Compare 2 — the files that commit holds. The manifest keys are blob
    // shas from the tree read, so this runs before any file is read.
    const manifestHash = contentManifestHash(
      scan.passes.flatMap((pass) => pass.manifestEntries),
    );
    if (manifestHash === source.lastManifestHash && !reportIsStale) {
      // No file was read, so no per-file warning can be regenerated here.
      // The discovery warnings can: they are facts about paths and names,
      // and discovery just ran. `carryWarning` covers the rest.
      return this.recordSuccess(source, {
        headSha: head.sha,
        manifestHash,
        changed: false,
        complete: true,
        carryWarning: true,
        discovered: totalDiscovered(scan),
        excluded: totalExcluded(scan),
        discovery: scan.discovery,
        warnings: scan.passes.flatMap((pass) => pass.warnings),
        notice: noticeOf(
          scan.discovery,
          source,
          scan.passes.map((pass) => ({ pass, result: NOTHING_RECONCILED })),
        ),
      });
    }

    const read = await this.readContents(source, head.sha, reader, scan);
    const applied = await this.reconcile(source, scan, read.text);
    const totals = totalOf(applied);
    return this.recordSuccess(source, {
      headSha: head.sha,
      manifestHash,
      changed: totals.imported + totals.updated + totals.deleted > 0,
      // A file discovery found and the sync could not read leaves the
      // manifest hash describing files nobody read. Recording it would make
      // compare 2 skip the whole commit forever, so this sync is incomplete
      // and records neither the commit nor the hash.
      complete: read.unread.length === 0,
      discovered: totalDiscovered(scan),
      excluded: totalExcluded(scan),
      discovery: scan.discovery,
      imported: totals.imported,
      updated: totals.updated,
      deleted: totals.deleted,
      warnings: [
        ...scan.passes.flatMap((pass) => pass.warnings),
        ...read.warnings,
        ...applied.flatMap(({ result }) => result.warnings),
      ],
      notice: noticeOf(scan.discovery, source, applied),
    });
  }

  /**
   * Reads the body of every file the scan asked for, and returns the content
   * keyed by FILE PATH — never by name, so two same-named files of different
   * kinds cannot overwrite each other.
   *
   * A pass that already holds a body keeps it: the directory walk learns a
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
   * tree read and the file reads hides a file until somebody edits it.
   */
  private async readContents(
    source: ContentSourceRow,
    headSha: string,
    reader: SkillRepoReader,
    scan: SyncScan,
  ): Promise<{ text: Map<string, string>; unread: string[]; warnings: string[] }> {
    const text = new Map<string, string>();
    for (const pass of scan.passes) {
      for (const [path, body] of pass.text) text.set(path, body);
    }
    const unread: string[] = [];
    const warnings: string[] = [];
    for (const pass of scan.passes) {
      for (const entry of pass.readEntries) {
        if (text.has(entry.path)) continue;
        const file = await reader.readFile(source.repoFullName, entry.path, headSha);
        if (file === null) {
          unread.push(entry.path);
          warnings.push(pass.unreadWarning(entry.path));
          continue;
        }
        text.set(entry.path, file.text);
      }
    }
    return { text, unread, warnings };
  }

  /**
   * Finds the files the commit holds, for every kind this source collects.
   * One recursive tree read serves every collector; the per-directory walk
   * below runs only when GitHub cut that tree AND the source names a
   * subdirectory to walk instead.
   *
   * The reader is passed in rather than read from `deps`, so every read in
   * one sync carries the credential `run` resolved for that source.
   */
  private async readManifest(
    source: ContentSourceRow,
    head: SkillRepoHead,
    reader: SkillRepoReader,
  ): Promise<SyncScan> {
    const collectors = this.collectorsFor(source);
    const tree = await reader.listTree(source.repoFullName, head.treeSha);
    if (!tree.truncated) {
      // The subdirectory has to exist before its emptiness means anything.
      // See `SkillRepoSubpathNotFoundError`: without this test, a renamed or
      // misspelled subdirectory reads as "the repository holds nothing" and
      // reconcile deletes every mirrored row.
      if (!treeHoldsSubpath(tree.entries, source.subpath)) {
        throw new SkillRepoSubpathNotFoundError(source.repoFullName, source.subpath, source.ref);
      }
      const scan: SyncScan = {
        passes: collectors.map((collector) =>
          collector.discover({ entries: tree.entries, source }),
        ),
        discovery: "tree",
      };
      this.assertCandidateBudget(source, scan);
      return scan;
    }
    // A cut tree must never reconcile, for the reason the truncation errors
    // carry. With a subdirectory there is somewhere smaller to look, and the
    // contents endpoint has its own cut guard; without one there is not.
    if (source.subpath.length === 0) {
      throw new SkillRepoTreeTruncatedError(source.repoFullName);
    }
    const passes: CollectorPass[] = [];
    for (const collector of collectors) {
      if (collector.walkDirectory === undefined) continue;
      passes.push(await collector.walkDirectory({ source, headSha: head.sha, reader }));
    }
    const scan: SyncScan = { passes, discovery: "directory-walk" };
    this.assertCandidateBudget(source, scan);
    return scan;
  }

  /**
   * One request found the paths; the contents are still one request each, in
   * sequence. `MAX_SKILL_CANDIDATES` is the shared cap over every kind: the
   * cost it bounds is the file reads, which cost the same whatever kind asked
   * for them.
   */
  private assertCandidateBudget(source: ContentSourceRow, scan: SyncScan): void {
    const discovered = totalDiscovered(scan);
    if (discovered > MAX_SKILL_CANDIDATES) {
      throw new SkillRepoTooManySkillsError(
        source.repoFullName,
        discovered,
        MAX_SKILL_CANDIDATES,
      );
    }
  }

  /** Runs every pass's reconcile, keeping each result WITH the pass that
   * produced it. The row's counts are the sum; a pass's own notice reads its
   * own result and never the sum. */
  private async reconcile(
    source: ContentSourceRow,
    scan: SyncScan,
    text: Map<string, string>,
  ): Promise<AppliedPass[]> {
    const applied: AppliedPass[] = [];
    for (const pass of scan.passes) {
      const result = await pass.reconcile({
        db: this.deps.db,
        source,
        text,
        discovery: scan.discovery,
        now: this.now,
      });
      applied.push({ pass, result });
    }
    return applied;
  }

  private async recordSuccess(
    source: ContentSourceRow,
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
      discovery?: ContentDiscoveryMode | null;
      /**
       * False when a file discovery found could not be read. The two cheap
       * compares key off `last_sha` and `last_manifest_hash`, so recording
       * either after a partial read tells the next poll that this commit is
       * already mirrored. It is not. An incomplete sync therefore leaves
       * both columns where they were, and the next poll reads the commit
       * again.
       */
      complete: boolean;
      /** Set when this poll stopped at a compare and read no file. It
       * learned nothing that could clear the last poll's report, so that
       * report stays on the row. */
      carryWarning?: boolean;
    },
  ): Promise<ContentSyncOutcome> {
    const warnings = result.warnings ?? [];
    const notice = result.notice ?? null;
    const now = this.now();
    // A message about the repository comes first, then one line per skipped
    // file. `last_error` is the one column the panel prints.
    const lines = [...(notice === null ? [] : [notice]), ...warnings];
    const carried = result.carryWarning === true && source.status === "warning";
    const status = lines.length > 0 || carried ? "warning" : "ok";
    const message =
      lines.length > 0
        ? lines.join("\n").slice(0, MAX_STATUS_CHARS)
        : carried
          ? source.lastError
          : null;
    await this.deps.db
      .update(contentSources)
      .set({
        status,
        attempts: 0,
        nextAttemptAt: now + SYNC_INTERVAL_MS,
        lastSha: result.complete ? result.headSha : source.lastSha,
        lastManifestHash: result.complete ? result.manifestHash : source.lastManifestHash,
        // Recorded with the commit and for the same reason: an incomplete
        // sync did not read the commit it is about to record, so it has not
        // finished reading the repository under these rules either.
        discoveryRulesVersion: result.complete
          ? DISCOVERY_RULES_VERSION
          : source.discoveryRulesVersion,
        lastSyncedAt: now,
        lastError: message,
        updatedAt: now,
      })
      .where(eq(contentSources.id, source.id));

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
  private async recordFailure(source: ContentSourceRow, err: unknown): Promise<ContentSyncOutcome> {
    const now = this.now();
    const attempts = source.attempts + 1;
    const backoff = BACKOFF_MS[attempts - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1] ?? POLL_MS;
    const message = err instanceof Error ? err.message : String(err);
    await this.deps.db
      .update(contentSources)
      .set({
        status: "error",
        attempts,
        nextAttemptAt: now + backoff,
        lastError: message.slice(0, MAX_STATUS_CHARS),
        updatedAt: now,
      })
      .where(eq(contentSources.id, source.id));

    // A repository or a subdirectory that vanished is worth a log line: it
    // does not clear on its own, and it holds a mirror still. A transient
    // GitHub fault is already visible on the source row.
    if (err instanceof SkillRepoNotFoundError || err instanceof SkillRepoSubpathNotFoundError) {
      console.warn(`content sync ${source.id}: ${message}`);
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

function totalDiscovered(scan: SyncScan): number {
  return scan.passes.reduce((sum, pass) => sum + pass.discovered, 0);
}

function totalExcluded(scan: SyncScan): number {
  return scan.passes.reduce((sum, pass) => sum + pass.excluded, 0);
}

/** What every pass wrote, added up. This is the row's report; it is not
 * what any one pass's notice is allowed to read. */
function totalOf(applied: AppliedPass[]): {
  imported: number;
  updated: number;
  deleted: number;
} {
  return applied.reduce(
    (sum, { result }) => ({
      imported: sum.imported + result.imported,
      updated: sum.updated + result.updated,
      deleted: sum.deleted + result.deleted,
    }),
    { imported: 0, updated: 0, deleted: 0 },
  );
}

/** Every collector's message about the repository, in collector order. Each
 * pass is handed its OWN reconcile result: a message that named the sweep's
 * total would report one kind's deletions as another kind's. Null when no
 * collector has anything to say. */
function noticeOf(
  discovery: ContentDiscoveryMode,
  source: ContentSourceRow,
  applied: AppliedPass[],
): string | null {
  const lines = applied
    .map(({ pass, result }) =>
      pass.notice({ source, discovery, deleted: result.deleted, keptStale: result.keptStale }),
    )
    .filter((line): line is string => line !== null);
  return lines.length === 0 ? null : lines.join("\n");
}
