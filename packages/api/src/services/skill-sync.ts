/**
 * Skill sync — mirrors a public GitHub repository's skills into the `skills`
 * table, and keeps mirroring as the repository moves.
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
 *    API call. Unauthenticated GitHub allows 60 calls per hour per IP, so
 *    this is not a micro-optimisation, it is what makes polling affordable.
 * 2. Only when the commit moved: list the skill directories, read each
 *    `SKILL.md`, and hash a canonical manifest of what came back. If the hash
 *    equals `last_manifest_hash`, record the new commit and stop without
 *    touching a single skill row — a commit that changed the README must not
 *    churn every mirrored skill's `updated_at`.
 *
 * Every read after step 1 is pinned to the commit step 1 resolved, so a
 * branch that moves mid-sync cannot produce a manifest that mixes two
 * commits.
 *
 * ## Layout
 *
 * The Agent Skills layout is `<root>/<skill-name>/SKILL.md`, so enumeration
 * is "list the root, then read each directory's SKILL.md" — two composed
 * calls, never a recursive tree walk. A directory with no `SKILL.md` is not a
 * skill and is skipped in silence; a repository root normally holds several.
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
import { parseMarkdownArtifact, validateSkillFrontmatter } from "@valet/engine";
import { isPgUniqueViolation } from "@valet/store-postgres";
import type { AppDb } from "../lib/drizzle.js";
import { skills, skillSources, type SkillRow, type SkillSourceRow } from "../schema/index.js";
import { newSkillId, skillContentSha } from "./skills.js";
import { SkillRepoNotFoundError, type SkillRepoReader } from "./skill-repo-reader.js";

/** How long a healthy source waits before its next poll. Unauthenticated
 * GitHub allows 60 requests per hour per IP, and an unchanged source costs
 * one, so this budgets four calls per hour per source. */
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
const SKILL_FILE = "SKILL.md";

/** One skill file as the repository holds it. `name` is the DIRECTORY name,
 * which is the spec's skill name and the only identity available before the
 * frontmatter parses. */
export interface SkillManifestEntry {
  name: string;
  path: string;
  contentSha: string;
}

export interface SkillSyncOutcome {
  /** `ok` — synced with nothing to report. `warning` — synced, but at least
   * one skill was skipped. `error` — nothing was reconciled. */
  status: "ok" | "warning" | "error";
  /** False when the poll stopped at one of the two compares. */
  changed: boolean;
  headSha: string | null;
  imported: number;
  updated: number;
  deleted: number;
  warnings: string[];
  error: string | null;
}

export interface SkillSyncDeps {
  db: AppDb;
  reader: SkillRepoReader;
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

/**
 * Hash over the canonical manifest. Entries are sorted by name and rendered
 * as compact JSON, so the hash depends on what the repository holds and not
 * on the order GitHub happened to list it in.
 */
export function skillManifestHash(entries: SkillManifestEntry[]): string {
  const canonical = [...entries]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({ name: e.name, path: e.path, contentSha: e.contentSha }));
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

/** SHA-256 of a `SKILL.md` exactly as the repository holds it, frontmatter
 * included. Distinct from `SkillRow.contentSha`, which covers the body only —
 * a frontmatter-only edit must move the manifest. */
function fileSha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
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
    const { reader } = this.deps;

    // Compare 1 — the head commit.
    const headSha = await reader.headSha(source.repoFullName, source.ref);
    if (headSha === source.lastSha) {
      return this.recordSuccess(source, { headSha, manifestHash: source.lastManifestHash, changed: false });
    }

    // Everything below reads at `headSha`, never at the moving ref.
    const manifest = await this.readManifest(source, headSha);

    // Compare 2 — the skills that commit holds.
    const manifestHash = skillManifestHash(manifest.entries);
    if (manifestHash === source.lastManifestHash) {
      return this.recordSuccess(source, { headSha, manifestHash, changed: false });
    }

    const applied = await this.reconcile(source, manifest.entries, manifest.text);
    return this.recordSuccess(source, {
      headSha,
      manifestHash,
      changed: applied.imported + applied.updated + applied.deleted > 0,
      ...applied,
    });
  }

  /** Lists the skill directories at `headSha` and reads each `SKILL.md`. */
  private async readManifest(
    source: SkillSourceRow,
    headSha: string,
  ): Promise<{ entries: SkillManifestEntry[]; text: Map<string, string> }> {
    const listing = await this.deps.reader.listDirectory(
      source.repoFullName,
      source.subpath,
      headSha,
    );
    const entries: SkillManifestEntry[] = [];
    const text = new Map<string, string>();

    for (const dir of listing.entries) {
      if (dir.type !== "dir") continue;
      const path = joinPath(source.subpath, dir.name, SKILL_FILE);
      // A read fault here propagates and fails the whole sync. Only "the
      // file is not there" (null) is a normal answer, and it means the
      // directory is not a skill.
      const content = await this.deps.reader.readFile(source.repoFullName, path, headSha);
      if (content === null) continue;
      entries.push({ name: dir.name, path, contentSha: fileSha(content) });
      text.set(dir.name, content);
    }
    return { entries, text };
  }

  /**
   * Brings this source's mirrored rows in line with `entries`.
   *
   * The delete is a set reconcile over the names the repository still holds,
   * scoped to `source_id` AND `origin='repo'`. A directory that failed
   * validation stays in that set: it is still upstream, so its previous row
   * is kept rather than deleted on the strength of a typo in its frontmatter.
   */
  private async reconcile(
    source: SkillSourceRow,
    entries: SkillManifestEntry[],
    text: Map<string, string>,
  ): Promise<{ imported: number; updated: number; deleted: number; warnings: string[] }> {
    const { db } = this.deps;
    const existing = await db
      .select()
      .from(skills)
      .where(and(eq(skills.sourceId, source.id), eq(skills.origin, "repo")));
    const byName = new Map(existing.map((row) => [row.name, row]));
    const upstream = new Set(entries.map((e) => e.name));

    const warnings: string[] = [];
    let imported = 0;
    let updated = 0;

    for (const entry of entries) {
      const raw = text.get(entry.name);
      if (raw === undefined) continue;
      const parsed = parseSkillFile(raw, entry.name);
      if (parsed.violations.length > 0) {
        warnings.push(`${entry.name}: ${parsed.violations.join(" ")}`);
        continue;
      }
      const row = byName.get(entry.name);
      if (row === undefined) {
        const wrote = await this.insertMirror(source, entry, parsed);
        if (wrote) imported += 1;
        else {
          warnings.push(
            `${entry.name}: a skill with this name already exists here. Rename the skill directory, or remove the skill that holds the name.`,
          );
        }
        continue;
      }
      if (await this.updateMirror(row, entry, parsed)) updated += 1;
    }

    const stale = existing.filter((row) => !upstream.has(row.name)).map((row) => row.id);
    if (stale.length > 0) {
      // Scoped by source AND origin a second time: this delete must stay off
      // a local skill and off another source's rows even if the id list were
      // ever computed wrong.
      await db
        .delete(skills)
        .where(
          and(inArray(skills.id, stale), eq(skills.sourceId, source.id), eq(skills.origin, "repo")),
        );
    }
    return { imported, updated, deleted: stale.length, warnings };
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
    },
  ): Promise<SkillSyncOutcome> {
    const warnings = result.warnings ?? [];
    const now = this.now();
    const status = warnings.length > 0 ? "warning" : "ok";
    await this.deps.db
      .update(skillSources)
      .set({
        status,
        attempts: 0,
        nextAttemptAt: now + SYNC_INTERVAL_MS,
        lastSha: result.headSha,
        lastManifestHash: result.manifestHash,
        lastSyncedAt: now,
        lastError: warnings.length > 0 ? warnings.join("\n").slice(0, MAX_STATUS_CHARS) : null,
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

    // A repository that vanished is worth a log line; a transient GitHub
    // fault is already visible on the source row.
    if (err instanceof SkillRepoNotFoundError) {
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
      error: message,
    };
  }
}

interface ParsedSkillFile {
  name: string;
  description: string;
  body: string;
  frontmatter: Record<string, unknown>;
  violations: string[];
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
  const violations = validateSkillFrontmatter(frontmatter, { directoryName }).map((v) => v.message);
  return {
    name: typeof frontmatter.name === "string" ? frontmatter.name : directoryName,
    description: typeof frontmatter.description === "string" ? frontmatter.description : "",
    body: parsed.body.trimStart(),
    frontmatter,
    violations,
  };
}

/** Joins path parts, dropping the empty ones a root-level source produces. */
function joinPath(...parts: string[]): string {
  return parts.filter((part) => part.length > 0).join("/");
}
