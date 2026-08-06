/**
 * One level of a repository directory, read through the contents endpoint
 * (`GET /repos/{owner}/{repo}/contents/{path}`). That endpoint returns a
 * JSON ARRAY when the path is a directory and a single object when it is a
 * file, so one call serves both `github.read_repo_file` and
 * `github.list_repo_directory`.
 *
 * The listing is deliberately NOT recursive. A caller that needs a tree
 * composes: list a directory, then read or list what it found. An Agent
 * Skills repository is `<root>/<skill-name>/SKILL.md`, so that is two
 * calls, not a walk.
 *
 * The page loop is manual. `octokit.paginate` needs the `Link` response
 * header, which the contents endpoint does not always send, so this asks
 * for the next page until a short page arrives or the cap is reached.
 */

/** Entries returned in one call. A skills directory is small; this cap
 * stops a mistargeted call from pulling a whole repository into context. */
export const MAX_DIRECTORY_ENTRIES = 500;

const PER_PAGE = 100;

export interface DirectoryEntry {
  name: string;
  path: string;
  /** GitHub's own kind: "file", "dir", "symlink", or "submodule". */
  type: string;
  size: number;
  sha: string;
}

export type DirectoryListing =
  | { kind: "directory"; entries: DirectoryEntry[]; complete: boolean }
  | { kind: "not_directory"; type: string };

export interface ContentsParams {
  owner: string;
  repo: string;
  path: string;
  ref?: string;
}

/**
 * What one page request receives. The index signature is what Octokit's
 * own `RequestParameters` demands, so these params pass straight to
 * `octokit.request` with no cast at the call site.
 */
export type ContentsRequestParams = ContentsParams & {
  per_page: number;
  page: number;
  [parameter: string]: unknown;
};

/**
 * The narrow slice of `octokit.request` this module needs. `data` stays
 * `unknown` because the endpoint's shape depends on the path kind — the
 * narrowing below is the only place that decides what came back.
 */
export type ContentsRequest = (params: ContentsRequestParams) => Promise<{ data: unknown }>;

/**
 * Error text for a contents path whose kind is not the one the caller
 * wanted. Names the action that DOES handle that kind, per the repo rule
 * that a user-facing error names the corrective action.
 */
export function wrongPathKindError(kind: string, wanted: "file" | "directory"): string {
  const hint =
    kind === "directory"
      ? " Use github.list_repo_directory to list a directory."
      : kind === "file"
        ? " Use github.read_repo_file to read a file."
        : "";
  return `Path is a ${kind}, not a ${wanted}.${hint}`;
}

/** Reads GitHub's `type` off a contents object. Unknown shapes report
 * "unknown" rather than throwing — the caller only needs a kind to name. */
export function contentsKind(data: unknown): string {
  if (Array.isArray(data)) return "directory";
  if (typeof data !== "object" || data === null) return "unknown";
  // Narrowing an `unknown` body from the API: `typeof === "object"` cannot
  // express indexability in TS, so the record cast is the read seam.
  const type = (data as Record<string, unknown>).type;
  return typeof type === "string" ? type : "unknown";
}

function toEntry(raw: unknown): DirectoryEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  // Same narrowing seam as `contentsKind` above.
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || typeof r.path !== "string" || typeof r.type !== "string") {
    return null;
  }
  return {
    name: r.name,
    path: r.path,
    type: r.type,
    size: typeof r.size === "number" ? r.size : 0,
    sha: typeof r.sha === "string" ? r.sha : "",
  };
}

/**
 * Collects one level of `params.path`, following pages until the directory
 * ends or `maxEntries` is reached. A truncated listing reports
 * `complete: false` — a short listing that claims to be whole is how an
 * importer silently skips skills.
 */
export async function collectDirectoryEntries(
  request: ContentsRequest,
  params: ContentsParams,
  maxEntries: number,
): Promise<DirectoryListing> {
  const entries: DirectoryEntry[] = [];
  let truncated = false;

  for (let page = 1; ; page += 1) {
    const { data } = await request({ ...params, per_page: PER_PAGE, page });
    if (!Array.isArray(data)) {
      // Only the first page answers "is this path a directory". Once it
      // said yes, a later page that is not a list is a broken response.
      // Reporting it as `not_directory` would drop the entries already
      // read and tell the caller the directory is not there.
      if (page > 1) {
        throw new Error(
          `GitHub sent ${contentsKind(data)} instead of a list for page ${page} of "${params.path}". Try the action again.`,
        );
      }
      return { kind: "not_directory", type: contentsKind(data) };
    }

    for (const raw of data) {
      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }
      const entry = toEntry(raw);
      if (entry) entries.push(entry);
    }

    if (truncated) break;
    // A page shorter than the page size is the last page. The contents
    // endpoint sends no reliable `Link` header, so this is the signal.
    if (data.length < PER_PAGE) break;
  }

  return { kind: "directory", entries, complete: !truncated };
}
