/**
 * The seam between the generic sync rail (`content-sync/service.ts`) and the
 * rules of one content kind. The rail owns credentials, the two compares, the
 * tree read, the file reads, the claim loop, and the retry ladder, and no rule
 * about `SKILL.md` or about any table a mirror lands in. Read it before you
 * write a collector: it states the rules every collector holds to.
 *
 * `discover` returns a `CollectorPass` — what the collector found at this
 * commit, WITH the writes bound to it. A plain manifest plus
 * `collector.reconcile(manifest)` would let one collector's manifest reach
 * another collector's reconcile; binding the two makes that unrepresentable.
 */
import { createHash } from "node:crypto";
import type { AppDb } from "../../lib/drizzle.js";
import type { ContentKind, ContentSourceRow } from "../../schema/index.js";
import type { SkillRepoReader, SkillTreeEntry } from "../skill-repo-reader.js";

/**
 * The version of the discovery RULES — which paths the collectors claim.
 *
 * Raise it when a change makes the SAME commit yield a different candidate
 * set: a new directory, extension, exclusion rule or kind. Raising it makes
 * every source re-scan once — see compare 1 in `content-sync/service.ts`.
 *
 * It does NOT reach a change to what a collector WRITES from a file it
 * already found. `contentManifestHash` covers name, path and blob sha only,
 * so compare 2 still short-circuits while the files are unchanged. Nothing
 * re-renders mirrored rows today.
 */
export const DISCOVERY_RULES_VERSION = 1;

/**
 * What a complete sync records in `skill_sources.discovery_scan`: the rules
 * version, the kinds this source collects, then the commit those rules read.
 *
 * The commit is paired with the version for rollback. A release that does not
 * know this column still advances `last_sha`, so a bare version would outlive
 * a sync under the old rules and then claim a head it never read.
 *
 * The pairing alone does not cover a rollback that re-syncs at the SAME
 * commit, which an errored source does on every poll. `recordFailure` clears
 * the mark for that reason, so the two rules hold it together.
 */
export function discoveryScanMark(commitSha: string, kinds: readonly ContentKind[]): string {
  // The KINDS are in the mark for the same reason the version is: they decide
  // which collectors run, so the same commit yields a different candidate set
  // when they change. Without them, adding a kind to an existing source
  // leaves its stored mark matching, compare 1 short-circuits, and the newly
  // claimed content is never mirrored until an unrelated commit lands.
  // Sorted, so two equivalent orders produce one mark.
  return `${DISCOVERY_RULES_VERSION}:${[...kinds].sort().join(",")}:${commitSha}`;
}

/** One tracked file as the repository holds it. `name` comes from the PATH,
 * the only identity available before the body is read. */
export interface ContentManifestEntry {
  name: string;
  path: string;
  /** Git blob sha, carried by the tree read, so the manifest compare runs
   * before any body is read. Not a mirrored row's `content_sha`, which hashes
   * something else. */
  blobSha: string;
}

/** How discovery found the files. `directory-walk` means GitHub cut the tree
 * and the sync listed the configured subdirectory instead, which finds
 * strictly less: one level, one directory. */
export type ContentDiscoveryMode = "tree" | "directory-walk";

/** A pure pass over one commit's tree listing. */
export interface CollectorDiscoverContext {
  entries: SkillTreeEntry[];
  source: ContentSourceRow;
}

/** The narrower fallback, for a commit whose tree GitHub cut. The reader is
 * passed in so every read of one sync carries that sync's credential. */
export interface CollectorWalkContext {
  source: ContentSourceRow;
  headSha: string;
  reader: SkillRepoReader;
}

export interface CollectorReconcileContext {
  db: AppDb;
  source: ContentSourceRow;
  /** The commit every body in `text` was read at. A collector that records
   * provenance writes this and never the ref, which moves. */
  commitSha: string;
  /** The body of every file this pass asked for, keyed by PATH and never by
   * name, so two same-named files of different kinds cannot overwrite each
   * other. */
  text: Map<string, string>;
  discovery: ContentDiscoveryMode;
  /** Injected clock, for a deterministic test schedule. */
  now: () => number;
}

export interface CollectorReconcileResult {
  imported: number;
  updated: number;
  deleted: number;
  /** Rows this pass would have deleted and kept instead, by name. Non-empty
   * only when the scan was narrower than the one that mirrored them. */
  keptStale: string[];
  /**
   * Rows this pass left unfinished for a reason the REPOSITORY cannot clear,
   * by name — a mirrored workflow whose file is gone and whose run has not
   * settled, for instance.
   *
   * A non-empty list makes the sync incomplete, exactly as an unread file
   * does: `last_sha` and `last_manifest_hash` stay where they were, so the
   * next poll re-reads and retries. Without it both compares short-circuit
   * on an unmoved repository and the work waits for an unrelated commit.
   */
  deferred?: string[];
  /** One line per file this pass skipped. */
  warnings: string[];
}

/** What one pass needs to write its message about the REPOSITORY. The counts
 * are THIS pass's own and never the sweep's total, or a sync that deleted one
 * workflow would report it as a deleted skill. */
export interface CollectorNoticeContext {
  source: ContentSourceRow;
  discovery: ContentDiscoveryMode;
  deleted: number;
  keptStale: string[];
}

/** One collector's work for ONE commit: discovery, and the writes bound to it. */
export interface CollectorPass {
  readonly kind: ContentKind;
  /** Files whose bodies reconcile needs, in the order reconcile wants them. */
  readonly readEntries: ContentManifestEntry[];
  /** The same files in canonical order — the manifest-hash input. Canonical
   * means independent of how GitHub listed the tree. */
  readonly manifestEntries: ContentManifestEntry[];
  /** Bodies discovery already read, keyed by PATH. Empty after a tree read;
   * the directory walk fills it, because it reads a file to learn its blob
   * sha, and that body must not be fetched twice. */
  readonly text: Map<string, string>;
  /** One line per candidate found and not collected. */
  readonly warnings: string[];
  /** Candidates that passed the shape test and the subdirectory filter,
   * before names collided and before any body was read. */
  readonly discovered: number;
  /** Candidates dropped because an ancestor directory is not scanned. */
  readonly excluded: number;
  /** Brings this source's mirrored rows of this kind in line with the pass. */
  reconcile(ctx: CollectorReconcileContext): Promise<CollectorReconcileResult>;
  /** What this pass says about the REPOSITORY, as distinct from the per-file
   * warnings. Null when there is nothing to say. */
  notice(ctx: CollectorNoticeContext): string | null;
  /** One line for a file discovery found and the sync could not read. */
  unreadWarning(path: string): string;
}

export interface ContentCollector {
  readonly kind: ContentKind;
  /** Pure discovery over one tree listing. */
  discover(ctx: CollectorDiscoverContext): CollectorPass;
  /** Discovery for a commit whose tree GitHub cut. A kind with no fallback
   * leaves this out and mirrors nothing on such a commit; the sweep reports
   * `directory-walk`, which already forbids every delete. */
  walkDirectory?(ctx: CollectorWalkContext): Promise<CollectorPass>;
}

/**
 * Hash over the canonical manifest of a whole sync — every collector's
 * entries, in collector order. Only the three manifest fields go in, so the
 * hash follows the commit and not the listing order. The per-file key is the
 * git blob sha the tree read supplies, so the hash needs no file read.
 */
export function contentManifestHash(entries: ContentManifestEntry[]): string {
  const canonical = entries.map((e) => ({ name: e.name, path: e.path, blobSha: e.blobSha }));
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}
