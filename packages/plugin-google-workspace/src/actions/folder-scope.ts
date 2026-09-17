/**
 * Folder scope: the folders a person is willing to let Valet see in Drive.
 *
 * The scope lives on the person's own Drive credential, under
 * `metadata.driveFolderScope`, because the OAuth grant it narrows is theirs.
 * The api owns the read and write surface; this module owns enforcement.
 *
 * ## Why containment, not a query filter
 *
 * Drive v3 has no recursive query term. Its predecessor accepted
 * `'<id>' in ancestors`; v3 accepts `in parents` only, which matches direct
 * children. A subtree therefore cannot be expressed as one query, and
 * expanding a scope into every descendant folder id would mean an unbounded
 * BFS whose OR clause outgrows the `q` parameter.
 *
 * So enforcement rests on one primitive: `FolderContainment.isInside`, which
 * walks a file's parents upward until it reaches an allowed folder or runs
 * out of tree. Every category uses it — the result filter on a listing, the
 * target check on a read or a write, and the parent check on a create. One
 * primitive means one thing to audit. Two mechanisms could disagree, and a
 * disagreement in an access control reads as a bypass.
 *
 * ## Failure direction
 *
 * A scope that is set and cannot be evaluated denies. A Drive error while
 * walking parents, a tree deeper than the cap, an action this module does
 * not classify: each denies rather than falls through. A denial is worded
 * the way Drive words a missing file, so a scoped-out file is not
 * distinguishable from one that does not exist.
 */

const DRIVE_API = 'https://www.googleapis.com/drive/v3';

/** Drive file ids are URL-safe base64-ish. Reject anything else outright. */
const FOLDER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * How far up a parent chain to walk before giving up. Drive itself imposes
 * no depth limit; this bounds the request count for one check. A tree deeper
 * than this denies rather than guessing.
 */
const MAX_PARENT_DEPTH = 32;

/** What Drive says when a file is not there. A scoped-out file says the same. */
export const SCOPE_DENIAL =
  'File not found or access denied. It may be outside the folders this integration is allowed to use. ' +
  'Change the allowed folders in Settings → Integrations → Google Workspace.';

export interface FolderScope {
  /** Allowed root folder ids. Empty means deny everything. */
  folderIds: string[];
}

/** The credential shape this module reads. Mirrors `Credential` loosely. */
interface CredentialLike {
  metadata?: Record<string, unknown> | null;
}

/**
 * Read the scope off a credential.
 *
 * Returns `null` when no scope is set, which leaves Drive access as wide as
 * the OAuth grant. A scope that is present but holds no usable id returns an
 * empty list, which denies everything: a person who set a scope and then
 * emptied it has not asked for unrestricted access. Removing the restriction
 * is deleting the key, which the api exposes as its own call.
 */
export function resolveFolderScope(cred: CredentialLike | null): FolderScope | null {
  const raw = cred?.metadata?.['driveFolderScope'];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const ids = (raw as Record<string, unknown>)['folderIds'];
  if (!Array.isArray(ids)) return { folderIds: [] };
  const folderIds = ids.filter(
    (id): id is string => typeof id === 'string' && id.length > 0 && FOLDER_ID_PATTERN.test(id),
  );
  return { folderIds };
}

/** The collection keys the list and search actions return. */
const COLLECTION_KEYS = ['files', 'documents', 'folders', 'spreadsheets'] as const;

/**
 * Resolves whether a file sits inside an allowed folder, caching every
 * parent lookup.
 *
 * One instance serves one action invocation. A listing of 50 files in the
 * same folder costs one lookup per distinct file plus one per distinct
 * ancestor, and siblings share their ancestors, so the cache pays for
 * itself inside a single page.
 */
export class FolderContainment {
  private readonly parents = new Map<string, string[] | null>();
  private readonly verdicts = new Map<string, boolean>();

  constructor(
    private readonly token: string,
    private readonly allowed: ReadonlySet<string>,
  ) {}

  /**
   * True when `fileId` is the allowed folder itself, or sits anywhere below
   * one. Throws when Drive cannot answer, so the caller denies rather than
   * treating an outage as "not allowed" in a way it might later invert.
   */
  async isInside(fileId: string): Promise<boolean> {
    if (this.allowed.size === 0) return false;
    if (this.allowed.has(fileId)) return true;
    const cached = this.verdicts.get(fileId);
    if (cached !== undefined) return cached;

    // Breadth-first up the tree. A Drive file can have several parents, so
    // this is a DAG walk, not a single chain.
    const seen = new Set<string>([fileId]);
    let frontier = [fileId];
    let verdict = false;

    for (let depth = 0; depth < MAX_PARENT_DEPTH && frontier.length > 0 && !verdict; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        const parents = await this.parentsOf(id);
        if (parents === null) continue; // unreadable or root — nothing above it
        for (const parent of parents) {
          if (this.allowed.has(parent)) {
            verdict = true;
            break;
          }
          if (!seen.has(parent)) {
            seen.add(parent);
            next.push(parent);
          }
        }
        if (verdict) break;
      }
      frontier = next;
    }

    this.verdicts.set(fileId, verdict);
    return verdict;
  }

  /** Keep only the entries that sit inside the scope. */
  async filterIds<T extends { id?: unknown }>(items: readonly T[]): Promise<T[]> {
    const kept: T[] = [];
    for (const item of items) {
      if (typeof item.id !== 'string') continue; // no id to check means no proof it is allowed
      if (await this.isInside(item.id)) kept.push(item);
    }
    return kept;
  }

  private async parentsOf(fileId: string): Promise<string[] | null> {
    const cached = this.parents.get(fileId);
    if (cached !== undefined) return cached;

    const qs = new URLSearchParams({ fields: 'parents', supportsAllDrives: 'true' });
    const res = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?${qs}`, {
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      if (res.status === 404 || res.status === 403) {
        // The caller cannot see it, so it cannot be in their scope either.
        this.parents.set(fileId, null);
        return null;
      }
      // 401 has to reach the caller so token refresh can run; anything else
      // is an outage the caller must not read as a verdict.
      throw new Error(`Drive API ${res.status} while checking the folder scope`);
    }
    const data = (await res.json()) as { parents?: unknown };
    const parents = Array.isArray(data.parents)
      ? data.parents.filter((p): p is string => typeof p === 'string')
      : null;
    this.parents.set(fileId, parents);
    return parents;
  }
}

/**
 * Filter a list or search result down to the scope, in place of the
 * recursive Drive query the API does not offer.
 *
 * Every collection the listing actions return is filtered, and a `total`
 * beside it is recomputed. `nextPageToken` is left alone: it belongs to
 * Drive's own paging, and dropping it would strand the caller before the end
 * of the results. A page can therefore come back shorter than the requested
 * size, or empty with a token still set.
 */
export async function filterListResult(
  data: unknown,
  containment: FolderContainment,
): Promise<unknown> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return data;
  const record = data as Record<string, unknown>;
  const out: Record<string, unknown> = { ...record };
  for (const key of COLLECTION_KEYS) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    const kept = await containment.filterIds(value as Array<{ id?: unknown }>);
    out[key] = kept;
    if (typeof record['total'] === 'number') out['total'] = kept.length;
  }
  return out;
}
