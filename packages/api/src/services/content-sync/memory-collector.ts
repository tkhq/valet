/**
 * Memory files mirrored from a repository, on the rail
 * `content-sync/collector.ts` defines. Read that file first, and
 * `services/memory.ts` for what a memory file is.
 *
 * One root, `.valet/memory/**`, and one destination: every mirrored file
 * lands at `lib/<path under the root>`. `lib/` is not a new idea invented
 * here. It is the memory subsystem's own name for mounted, non-agent-authored
 * content, and `assertWritablePath` in `lib/okf.ts` already refuses every
 * agent and API write to it with the message "lib/ is reserved for mounted
 * libraries - write under notes/ or projects/". So a mirrored memory is
 * read-only in the product for free: no new guard, no new error, and no edit
 * to the four write paths, and the refusal already names what to do instead.
 *
 * That answers the question a mirror of an agent-writable store otherwise
 * raises. A workflow is read-only because the product never held the edit. A
 * memory file is different: the agent writes memory files constantly. It
 * writes them under `notes/`, `projects/` and `journal/`, and this mirror
 * cannot reach those.
 *
 * There is no second top-level root, unlike workflows. An OKF document has no
 * discriminator: `parseConcept` reads any Markdown file, so a top-level
 * `memory/` folder would claim files that are not memory at all, with nothing
 * in them to say so. `.valet/memory` is unambiguous and is the whole rule.
 *
 * Unlike workflows and templates, a USER source collects memories. A mirrored
 * memory runs nothing and resolves no credential, so decision 10's authority
 * argument does not reach it, and a personal repository of notes is the most
 * natural thing to want mirrored.
 */
import { and, eq, like } from "drizzle-orm";
import { memoryFiles, type ContentSourceRow } from "../../schema/index.js";
import { assertWritablePath, normalizePath, parseConcept } from "../../lib/okf.js";
import type {
  CollectorDiscoverContext,
  CollectorNoticeContext,
  CollectorPass,
  CollectorReconcileContext,
  CollectorReconcileResult,
  ContentCollector,
  ContentManifestEntry,
} from "./collector.js";

const MEMORY_ROOT = ".valet/memory";

/** Where a mirrored file lands. `lib/` is reserved for mounted libraries, so
 * putting mirrored content there is what makes it read-only. */
const MOUNT_PREFIX = "lib/";

export class MemoryCollector implements ContentCollector {
  readonly kind = "memories" as const;

  discover({ entries, source }: CollectorDiscoverContext): CollectorPass {
    const candidates: ContentManifestEntry[] = [];
    for (const entry of entries) {
      if (entry.type !== "blob" || entry.mode === "120000") continue;
      if (!entry.path.startsWith(`${MEMORY_ROOT}/`)) continue;
      if (!entry.path.endsWith(".md")) continue;
      const relative = entry.path.slice(MEMORY_ROOT.length + 1);
      if (relative.length === 0) continue;
      candidates.push({ name: relative, path: entry.path, blobSha: entry.sha });
    }
    candidates.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return new MemoryPass(candidates, source);
  }
}

/**
 * The memory path one repository path mounts at, or the reason it has none.
 *
 * `normalizePath` and `assertWritablePath` both THROW, and a repository path
 * is not ours to choose: a colon is legal in a git tree and ordinary in a
 * filename ("2026-08-24: retro.md"), and so is a basename the store reserves.
 * Throwing out of the reconcile loop would abort the pass and take every
 * OTHER memory file in the repository with it, on every poll, forever. One
 * file's name costs that file only.
 *
 * `assertWritablePath` is applied deliberately, with `lib/` allowed: it is
 * the rule a WRITTEN path obeys, and mirroring a path the product could never
 * hold would create a row no other code can address.
 */
function mountPath(repoPath: string): { ok: true; path: string } | { ok: false; reason: string } {
  const path = `${MOUNT_PREFIX}${repoPath.slice(MEMORY_ROOT.length + 1)}`;
  try {
    const normalized = normalizePath(path);
    // Strip the mount prefix for the reserved-name check, then put it back:
    // `lib/` is exactly what this collector is allowed to write and
    // `assertWritablePath` exists to refuse.
    assertWritablePath(normalized.slice(MOUNT_PREFIX.length));
    return { ok: true, path: normalized };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

class MemoryPass implements CollectorPass {
  readonly kind = "memories" as const;
  readonly readEntries: ContentManifestEntry[];
  readonly manifestEntries: ContentManifestEntry[];
  readonly text = new Map<string, string>();
  readonly warnings: string[] = [];
  readonly discovered: number;
  readonly excluded = 0;

  constructor(
    private readonly candidates: ContentManifestEntry[],
    private readonly source: ContentSourceRow,
  ) {
    this.discovered = candidates.length;
    this.readEntries = candidates;
    this.manifestEntries = candidates;
  }

  unreadWarning(path: string): string {
    return `${path} was in the repository listing and could not be read, so this memory file was not mirrored. Valet reads it again on the next sync.`;
  }

  /**
   * Brings this source's mirrored memory files in line with the commit.
   *
   * The owner tuple comes from the SOURCE, and the path is the mount path, so
   * `(owner_type, owner_id, path)` — the table's primary key — is determined
   * by the source and the file together. Two sources mounting one path for
   * one owner would collide, and the second reports rather than overwriting:
   * a mirror must never take a row another mirror owns.
   */
  async reconcile(ctx: CollectorReconcileContext): Promise<CollectorReconcileResult> {
    const { db, source, text, discovery, now } = ctx;
    const warnings: string[] = [];
    let imported = 0;
    let updated = 0;

    const existing = await db
      .select()
      .from(memoryFiles)
      .where(
        and(
          eq(memoryFiles.ownerType, source.ownerType),
          eq(memoryFiles.ownerId, source.ownerId),
          eq(memoryFiles.sourceId, source.id),
          // Scoped twice, as every mirror delete in this rail is: the source
          // AND the mounted namespace. A row outside `lib/` was written in
          // the product and is never this sweep's to remove.
          like(memoryFiles.path, `${MOUNT_PREFIX}%`),
        ),
      );
    const byPath = new Map(existing.map((row) => [row.upstreamPath ?? "", row]));
    // Seeded from discovery, before any body is read.
    const upstream = new Set(this.readEntries.map((entry) => entry.path));

    for (const candidate of this.candidates) {
      const raw = text.get(candidate.path);
      if (raw === undefined) continue;

      const mount = mountPath(candidate.path);
      if (!mount.ok) {
        warnings.push(
          `${candidate.path} cannot be mounted as a memory file: ${mount.reason}. Rename the file and push.`,
        );
        continue;
      }
      const path = mount.path;
      const row = byPath.get(candidate.path);
      if (row !== undefined && row.contentSha === candidate.blobSha) continue;

      // A row at this path that this source does not own is another source's
      // mirror, or something the product wrote before `lib/` was reserved.
      // Either way it is not this sweep's to take.
      const held = await db
        .select({ sourceId: memoryFiles.sourceId })
        .from(memoryFiles)
        .where(
          and(
            eq(memoryFiles.ownerType, source.ownerType),
            eq(memoryFiles.ownerId, source.ownerId),
            eq(memoryFiles.path, path),
          ),
        );
      const owner = held[0]?.sourceId ?? null;
      if (held.length > 0 && owner !== source.id) {
        warnings.push(
          `${candidate.path} mounts at ${path}, which another tracked repository already holds. Rename the file, or remove the other repository.`,
        );
        continue;
      }

      const parsed = parseConcept(raw);
      const title = parsed.title !== "" ? parsed.title : basename(path);
      const values = {
        title,
        content: parsed.body,
        type: parsed.type,
        description: parsed.description,
        tags: JSON.stringify(parsed.tags),
        resource: parsed.resource,
        extras: JSON.stringify(parsed.extras),
        sensitivity: parsed.valet.sensitivity ?? "private",
        // The document's own `valet.origin` is OKF provenance of the FACT and
        // says nothing about mirroring; it is carried through unchanged.
        origin: parsed.valet.origin ?? "",
        sourceId: source.id,
        upstreamPath: candidate.path,
        contentSha: candidate.blobSha,
        updatedAt: now(),
      };

      if (row === undefined) {
        await db.insert(memoryFiles).values({
          ownerType: source.ownerType,
          ownerId: source.ownerId,
          path,
          orgId: source.orgId,
          actorUserId: source.createdBy ?? "",
          version: 1,
          createdAt: now(),
          ...values,
        });
        imported += 1;
        continue;
      }
      await db
        .update(memoryFiles)
        .set({ ...values, path, version: row.version + 1 })
        .where(
          and(
            eq(memoryFiles.ownerType, source.ownerType),
            eq(memoryFiles.ownerId, source.ownerId),
            eq(memoryFiles.path, row.path),
          ),
        );
      updated += 1;
    }

    const stale = existing.filter((row) => !upstream.has(row.upstreamPath ?? ""));
    if (discovery === "directory-walk") {
      return { imported, updated, deleted: 0, keptStale: stale.map((row) => row.path), warnings };
    }
    let deleted = 0;
    for (const row of stale) {
      await db
        .delete(memoryFiles)
        .where(
          and(
            eq(memoryFiles.ownerType, source.ownerType),
            eq(memoryFiles.ownerId, source.ownerId),
            eq(memoryFiles.path, row.path),
            eq(memoryFiles.sourceId, source.id),
            like(memoryFiles.path, `${MOUNT_PREFIX}%`),
          ),
        );
      deleted += 1;
    }

    return { imported, updated, deleted, keptStale: [], warnings };
  }

  notice(ctx: CollectorNoticeContext): string | null {
    if (ctx.discovery === "directory-walk" && ctx.keptStale.length > 0) {
      return `${ctx.source.repoFullName} holds more files than Valet can read in one listing, so this scan was narrower than the one that mirrored these memory files. Valet kept ${ctx.keptStale.length} it did not reach.`;
    }
    if (this.discovered === 0 && this.source.kinds.includes("memories")) {
      return `Valet read ${ctx.source.repoFullName} and found no Markdown file under ${MEMORY_ROOT}/. Add one, or remove memories from what this repository collects.`;
    }
    return null;
  }
}

function basename(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}
