/**
 * Repository content sync — mirrors what a GitHub repository holds into
 * Valet's own tables, and keeps mirroring as the repository moves.
 *
 * This file is the rail: commits, trees, credentials, retries. Every per-kind
 * rule lives behind `ContentCollector` (`content-sync/collector.ts`). Design:
 * `docs/specs/2026-08-24-workflows-mvp-design.md`.
 *
 * The repository is authoritative. `syncOnce` is the only writer of a
 * `repo`-origin row, and every write and delete a collector makes is scoped by
 * `source_id` AND `origin='repo'`, so a row somebody wrote in the product
 * (`origin='local'`) is never touched.
 *
 * ## Two cheap compares
 *
 * 1. The head commit, AND that the last complete sync read it under the
 *    current discovery rules. Both equal means stop, so an unchanged poll
 *    costs ONE API call — an anonymous read gets 60 per hour per IP. The
 *    rules half lets a release change which paths a collector claims without
 *    waiting for an unrelated commit — see `discoveryScanMark`.
 * 2. The hash of one manifest over what every enabled collector found. Equal
 *    to `last_manifest_hash` means record the commit and touch no mirrored
 *    row. The per-file key is the git blob sha the tree read already carries,
 *    so this compare runs before any file is read.
 *
 * Every read after compare 1 is pinned to the commit it resolved, so a branch
 * that moves mid-sync cannot mix two commits into one manifest.
 *
 * ## What a fault may do
 *
 * A malformed file is a per-file warning on a successful sync; the commit IS
 * recorded, so the next poll stops after one call.
 *
 * A transport failure or a partial listing fails the whole sync and reconciles
 * NOTHING. Entries a sync did not see cannot be told apart from files the
 * repository no longer holds, and a GitHub outage must not read as "everything
 * was deleted upstream".
 *
 * A file discovery found and the read could not fetch makes the sync
 * INCOMPLETE: the other files still mirror, but neither the commit nor the
 * manifest hash is recorded, so the next poll reads that file again.
 *
 * A listing NARROWER than the one that mirrored the rows must never read as a
 * delete — a stale mirror is recoverable, a deleted row is not.
 * `CollectorReconcileContext.discovery` is how a collector learns of one.
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
  discoveryScanMark,
  type CollectorPass,
  type CollectorReconcileResult,
  type ContentCollector,
  type ContentDiscoveryMode,
} from "./collector.js";
import { SkillCollector } from "./skill-collector.js";

/** Next poll for a healthy source. An unchanged poll costs one API call, so
 * this fits four per hour inside the 60-per-hour anonymous budget. */
export const SYNC_INTERVAL_MS = 15 * 60_000;
/** How long a healthy org source waits when the GitHub App webhook is
 * not live. Members cannot press Sync, so this is the freshness path
 * until a `push` delivery can replace it. */
export const ORG_SYNC_INTERVAL_MS = 5 * 60_000;
/** How long a healthy org source waits when the App webhook is live. A
 * `push` calls `syncOnce`; this is only the backstop for a missed delivery. */
export const ORG_WEBHOOK_BACKSTOP_MS = 6 * 60 * 60_000;

/** The wait after a healthy poll. Personal and team sources keep the
 * longer wait because they still have Sync. An org source waits 5 minutes
 * unless the App webhook is live, in which case a `push` is the real path. */
export function syncIntervalMs(
  ownerType: ContentSourceRow["ownerType"],
  opts: { orgWebhookLive?: boolean } = {},
): number {
  if (ownerType !== "org") return SYNC_INTERVAL_MS;
  return opts.orgWebhookLive === true ? ORG_WEBHOOK_BACKSTOP_MS : ORG_SYNC_INTERVAL_MS;
}
/** Retry backoff per consecutive failure. A failure past the last entry
 * repeats it: a source is a standing subscription, so it keeps retrying at the
 * slowest rung instead of dying the way `event_deliveries` does. */
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000];
const POLL_MS = 60_000;
const BATCH = 10;
/** How long a claimed source stays invisible to other sweeps. */
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
  /** Why a sync imported nothing, when that needs saying. About the
   * REPOSITORY, where `warnings` is one line per skipped file. */
  notice: string | null;
  /** Files discovery found, across every enabled kind, before names collided
   * and before any file was parsed. */
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
   * holds that rule and supplies the only implementation. Without it every
   * sync uses `reader`. */
  readerFor?: (source: ContentSourceRow) => Promise<SkillRepoReader>;
  /** The collectors this deployment can run. A source runs the subset its
   * `kinds` column names. */
  collectors?: ContentCollector[];
  /** Injected clock, for a deterministic test schedule. */
  now?: () => number;
  /** True when GitHub can deliver App webhooks to this instance. Org
   * sources then use the long backstop; `push` is the real sync path. */
  orgWebhookLive?: () => boolean;
}

/**
 * Leases the due sources by moving `next_attempt_at` forward in the statement
 * that selects them. The due conditions are repeated on the OUTER update, and
 * that repeat is the cross-process fence — `events/dispatcher.ts` explains why
 * the `id IN (subquery)` part cannot fence on its own. A crash mid-sync leaves
 * the source claimed until the lease lapses.
 *
 * Exported so the fence is testable without the service.
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

/**
 * Sources that have been due longer than `olderThanMs`. The sweep reports
 * these and does not repair them: a silent catch-up would hide a worker
 * that cannot keep the org interval. Default is the org interval, because
 * that is the freshness members depend on.
 */
export async function overdueContentSources(
  db: AppDb,
  now: number,
  olderThanMs: number = ORG_SYNC_INTERVAL_MS,
): Promise<string[]> {
  const rows = await db
    .select({ id: contentSources.id })
    .from(contentSources)
    .where(and(eq(contentSources.enabled, true), lte(contentSources.nextAttemptAt, now - olderThanMs)));
  return rows.map((row) => row.id);
}

/** Every collector's work for one commit, with the discovery path that found
 * it: a collector's reconcile has to know whether the scan was the narrow one. */
interface SyncScan {
  passes: CollectorPass[];
  discovery: ContentDiscoveryMode;
}

/** One pass and what its OWN reconcile wrote, so one collector's counts cannot
 * reach another collector's notice. */
interface AppliedPass {
  pass: CollectorPass;
  result: CollectorReconcileResult;
}

/** Stands in for a reconcile that never ran, on a poll that stopped at a
 * compare. Read-only. */
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
    // Immediate pass, so a source added before the last shutdown does not wait
    // a full interval after boot.
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
      const now = this.now();
      const overdue = await overdueContentSources(this.deps.db, now);
      if (overdue.length > 0) {
        console.warn(
          `content sync: ${overdue.length} source(s) have been due longer than the org interval. ` +
            `The sweep is behind. Ids: ${overdue.join(", ")}.`,
        );
      }
      for (const id of await claimDueContentSources(this.deps.db, now)) {
        await this.syncOnce(id).catch((err) => console.error(`content sync ${id}:`, err));
      }
    } catch (err) {
      console.error("content sync: poll failed:", err);
    } finally {
      this.draining = false;
    }
  }

  /**
   * Syncs one source. The only sync implementation: the sweep and the "Sync
   * now" route both land here. Returns null when the source row is gone.
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

  /** The collectors this source's `kinds` enables, in registration order.
   * That order fixes the manifest hash, so it must not depend on the row. */
  private collectorsFor(source: ContentSourceRow): ContentCollector[] {
    return this.collectors.filter((collector) => source.kinds.includes(collector.kind));
  }

  private async run(source: ContentSourceRow): Promise<ContentSyncOutcome> {
    // Resolved once per sync, so every read of one commit uses one identity.
    const reader = this.deps.readerFor ? await this.deps.readerFor(source) : this.deps.reader;

    // Both compares below leave the row's report where it is, which is only
    // sound when that report describes a sync that finished. After a failure
    // it does not — `recordFailure` overwrote `last_error` — so an errored
    // source takes neither compare and regenerates its report by re-reading.
    const reportIsStale = source.status === "error";

    // Compare 1 — the head commit.
    const head = await reader.head(source.repoFullName, source.ref);

    // A release can change which paths a collector claims, and the head
    // commit then says nothing about whether this source is current. The row
    // carries the commit its rules read rather than a bare version, because a
    // release that does not know the column still advances `last_sha`.
    const scanIsStale = source.discoveryScan !== discoveryScanMark(head.sha);

    if (head.sha === source.lastSha && !reportIsStale && !scanIsStale) {
      // Nothing was re-read, so this poll learned nothing that could clear the
      // last report. Without `carryWarning` a source whose files are all broken
      // flips to a silent "ok" one interval later.
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

    // Compare 2 — the files that commit holds, keyed by blob sha from the tree
    // read, so this runs before any file is read.
    const manifestHash = contentManifestHash(
      scan.passes.flatMap((pass) => pass.manifestEntries),
    );
    if (manifestHash === source.lastManifestHash && !reportIsStale) {
      // No file was read, so only the discovery warnings can be regenerated
      // here. `carryWarning` covers the per-file ones.
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
    const applied = await this.reconcile(source, scan, read.text, head.sha);
    const totals = totalOf(applied);
    return this.recordSuccess(source, {
      headSha: head.sha,
      manifestHash,
      changed: totals.imported + totals.updated + totals.deleted > 0,
      // A file discovery found and the sync could not read leaves the manifest
      // hash describing files nobody read. Recording it would make compare 2
      // skip the whole commit forever. A pass that deferred work is incomplete
      // for the same reason: nothing in the repository will move to trigger
      // the retry.
      complete:
        read.unread.length === 0 &&
        applied.every((entry) => (entry.result.deferred?.length ?? 0) === 0),
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
   * Reads the body of every file the scan asked for, keyed by FILE PATH —
   * never by name, so two same-named files of different kinds cannot overwrite
   * each other. A pass that already holds a body keeps it.
   *
   * A read fault propagates and fails the whole sync. Only "the file is not
   * there" is a normal answer: that entry is dropped, its row is kept, and it
   * goes into `unread`, which is what makes the caller record neither the
   * commit nor the manifest hash and read the file again next poll.
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
   * Finds the files the commit holds, for every kind this source collects. One
   * recursive tree read serves every collector; the per-directory walk below
   * runs only when GitHub cut that tree AND the source names a subdirectory to
   * walk instead.
   */
  private async readManifest(
    source: ContentSourceRow,
    head: SkillRepoHead,
    reader: SkillRepoReader,
  ): Promise<SyncScan> {
    const collectors = this.collectorsFor(source);
    const tree = await reader.listTree(source.repoFullName, head.treeSha);
    if (!tree.truncated) {
      // The subdirectory has to exist before its emptiness means anything:
      // without this test a renamed or misspelled subdirectory reads as "the
      // repository holds nothing" and reconcile deletes every mirrored row.
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
    // A cut tree must never reconcile. With a subdirectory there is somewhere
    // smaller to look, and the contents endpoint has its own cut guard.
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
   * `MAX_SKILL_CANDIDATES` is one cap over every kind together: the cost it
   * bounds is the file reads, which cost the same whatever kind asked.
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
   * produced it. The row's counts are the sum; a pass's notice reads only its
   * own result. */
  private async reconcile(
    source: ContentSourceRow,
    scan: SyncScan,
    text: Map<string, string>,
    commitSha: string,
  ): Promise<AppliedPass[]> {
    const applied: AppliedPass[] = [];
    for (const pass of scan.passes) {
      const result = await pass.reconcile({
        db: this.deps.db,
        source,
        commitSha,
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
       * False when a file discovery found could not be read. Recording
       * `last_sha` or `last_manifest_hash` after a partial read would tell the
       * next poll that this commit is already mirrored. It is not, so an
       * incomplete sync leaves both columns where they were.
       */
      complete: boolean;
      /** Set when this poll stopped at a compare and read no file, so it
       * learned nothing that could clear the last poll's report. */
      carryWarning?: boolean;
    },
  ): Promise<ContentSyncOutcome> {
    const warnings = result.warnings ?? [];
    const notice = result.notice ?? null;
    const now = this.now();
    // Repository message first, then one line per skipped file. `last_error`
    // is the one column the panel prints.
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
        nextAttemptAt:
          now +
          syncIntervalMs(source.ownerType, { orgWebhookLive: this.deps.orgWebhookLive?.() === true }),
        lastSha: result.complete ? result.headSha : source.lastSha,
        lastManifestHash: result.complete ? result.manifestHash : source.lastManifestHash,
        discoveryScan: result.complete ? discoveryScanMark(result.headSha) : source.discoveryScan,
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
   * `last_manifest_hash` are left alone, so the next attempt re-reads.
   *
   * `discovery_scan` IS cleared. An errored source already skips the
   * head-commit compare and re-reads the tree, so clearing costs nothing,
   * and it closes a rollback window: a release that does not know the column
   * re-syncs at the same commit under its own rules and leaves the mark
   * behind, after which a later release would trust a mark for a scan its
   * rules never performed. Cleared, the mark means what it says: the last
   * sync that ran was complete AND used these rules. */
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
        discoveryScan: null,
        updatedAt: now,
      })
      .where(eq(contentSources.id, source.id));

    // A repository or subdirectory that vanished does not clear on its own and
    // still holds a mirror. A transient fault is visible on the source row.
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

/** What every pass wrote, added up. The row's report, and never what one
 * pass's notice may read. */
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
 * pass is handed its OWN reconcile result: the sweep's total would report one
 * kind's deletions as another kind's. Null when nobody has anything to say. */
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
