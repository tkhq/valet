/**
 * The seam between the generic repository sync rail and the rules of one
 * content kind.
 *
 * `services/content-sync/service.ts` owns everything that is true of every
 * kind: which credential the source reads with, the two cheap compares, the
 * one tree read, the file-body reads, the claim loop, and the retry ladder.
 * It knows nothing about `SKILL.md`, about a workflow envelope, or about any
 * table a mirror lands in. A `ContentCollector` holds all of that.
 *
 * That file also states, once, the rules every collector holds to: what a
 * transport failure, a file the sync could not read, a narrowed scan, and a
 * delete may each do. Read it before you write a collector.
 *
 * ## Why discovery returns an object and not plain data
 *
 * `discover` returns a `CollectorPass`: what this collector found at this
 * commit, WITH the writes bound to it. A pass carries the per-kind detail the
 * sweep must not see — which of two same-named files won, which names are
 * reserved, which candidates an exclusion rule dropped — and exposes only the
 * counts and entries the sweep itself needs.
 *
 * The alternative was a plain manifest plus `collector.reconcile(manifest)`.
 * It types worse and it is easy to get wrong: with several collectors in one
 * sweep, nothing stops one collector's manifest reaching another collector's
 * reconcile. Binding the two at discovery makes that unrepresentable, with no
 * generic parameter and no cast.
 */
import { createHash } from "node:crypto";
import type { AppDb } from "../../lib/drizzle.js";
import type { ContentKind, ContentSourceRow } from "../../schema/index.js";
import type { SkillRepoReader, SkillTreeEntry } from "../skill-repo-reader.js";

/**
 * The version of the discovery RULES — which paths in a repository the
 * collectors claim.
 *
 * Compare 1 in `service.ts` stops a poll whose head commit has not moved, and
 * that is what makes polling affordable. It is only sound while the rules
 * that read a commit are the rules that read it last time. A release that
 * opens a new folder to discovery would otherwise never re-scan a repository
 * nobody pushes to, and its newly discoverable content would appear only
 * after some unrelated commit landed.
 *
 * So a source records the version it last synced under, and compare 1
 * short-circuits only when the two match. A source at a stale version reads
 * the tree once more and then goes back to costing one call per poll.
 *
 * Raise this by one when a change makes the SAME commit yield a different
 * candidate set for any collector: a newly scanned directory, a new file
 * extension, a changed exclusion rule, a new kind. Do not raise it for a
 * change to what a collector writes from a file it already found — the
 * manifest hash covers that.
 */
export const DISCOVERY_RULES_VERSION = 1;

/** One tracked file as the repository holds it. `name` comes from the PATH,
 * because it is the only identity available before the file body is read. */
export interface ContentManifestEntry {
  name: string;
  path: string;
  /** Git blob sha. Named for what it is, because a mirrored row's own
   * `content_sha` is a different hash over a different thing. The tree read
   * carries this one, so the manifest compare runs before any body is read. */
  blobSha: string;
}

/** How discovery found the files. `directory-walk` says GitHub cut the tree
 * and the sync fell back to listing the configured subdirectory, which finds
 * strictly less: one level, one directory. */
export type ContentDiscoveryMode = "tree" | "directory-walk";

/** A pure pass over one commit's tree listing. */
export interface CollectorDiscoverContext {
  entries: SkillTreeEntry[];
  source: ContentSourceRow;
}

/** The narrower fallback, for a commit whose tree GitHub cut. The reader is
 * passed in rather than read from the service, so every read in one sync
 * carries the credential that sync resolved. */
export interface CollectorWalkContext {
  source: ContentSourceRow;
  headSha: string;
  reader: SkillRepoReader;
}

export interface CollectorReconcileContext {
  db: AppDb;
  source: ContentSourceRow;
  /** The body of every file this pass asked for, keyed by PATH. Keyed by
   * path and never by name, so two same-named files of different kinds
   * cannot overwrite each other. */
  text: Map<string, string>;
  discovery: ContentDiscoveryMode;
  /** Injected clock, so a test can drive a deterministic schedule. */
  now: () => number;
}

export interface CollectorReconcileResult {
  imported: number;
  updated: number;
  deleted: number;
  /** Rows this pass would have deleted and kept instead, by name. Non-empty
   * only when the scan was narrower than the one that mirrored them. */
  keptStale: string[];
  /** One line per file this pass skipped. */
  warnings: string[];
}

export interface CollectorNoticeContext {
  source: ContentSourceRow;
  discovery: ContentDiscoveryMode;
  deleted: number;
  keptStale: string[];
}

/**
 * One collector's work for ONE commit: what discovery found, and the writes
 * bound to it.
 */
export interface CollectorPass {
  readonly kind: ContentKind;
  /** Files whose bodies reconcile needs, in the order reconcile wants them. */
  readonly readEntries: ContentManifestEntry[];
  /** The same files in canonical order — the manifest-hash input. Canonical
   * means the order does not depend on how GitHub listed the tree. */
  readonly manifestEntries: ContentManifestEntry[];
  /** Bodies this discovery already read, keyed by PATH. Empty after a tree
   * read; the directory walk fills it, because it reads a file to learn its
   * blob sha, and that body must not be fetched twice. */
  readonly text: Map<string, string>;
  /** One line per candidate found and not collected. */
  readonly warnings: string[];
  /** Candidates that passed the shape test and the subdirectory filter,
   * before names collided and before any body was read. Zero says the
   * repository holds nothing of this kind. */
  readonly discovered: number;
  /** Candidates dropped because an ancestor directory is not scanned. */
  readonly excluded: number;
  /** Brings this source's mirrored rows of this kind in line with the pass. */
  reconcile(ctx: CollectorReconcileContext): Promise<CollectorReconcileResult>;
  /** What this pass must say about the REPOSITORY, as distinct from the
   * per-file warnings. Null when there is nothing to say. */
  notice(ctx: CollectorNoticeContext): string | null;
  /** One line for a file discovery found and the sync could not read. */
  unreadWarning(path: string): string;
}

export interface ContentCollector {
  readonly kind: ContentKind;
  /** Pure discovery over one tree listing. */
  discover(ctx: CollectorDiscoverContext): CollectorPass;
  /**
   * Discovery for a commit whose tree GitHub cut. A kind with no fallback
   * leaves this out, mirrors nothing on such a commit, and deletes nothing —
   * the sweep reports `directory-walk`, and that mode already forbids every
   * delete.
   */
  walkDirectory?(ctx: CollectorWalkContext): Promise<CollectorPass>;
}

/**
 * Hash over the canonical manifest of a whole sync — every collector's
 * entries, concatenated in collector order.
 *
 * Each entry is rendered as compact JSON with only the three manifest fields,
 * so the hash depends on the content of the commit and not on how a listing
 * was ordered or on what a collector carries beside these fields. The
 * per-file key is the git blob sha, which the tree read already supplies, so
 * this hash is computable with no file read.
 */
export function contentManifestHash(entries: ContentManifestEntry[]): string {
  const canonical = entries.map((e) => ({ name: e.name, path: e.path, blobSha: e.blobSha }));
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}
