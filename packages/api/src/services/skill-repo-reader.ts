/**
 * Reads a public GitHub repository for skill sync. Three operations, all
 * over endpoints the GitHub plugin's own actions already use:
 *
 *   1. `headSha`      — `GET /repos/{owner}/{repo}/commits/{ref}`
 *   2. `listDirectory` — `GET /repos/{owner}/{repo}/contents/{path}`
 *   3. `readFile`      — the same contents endpoint, on a file path
 *
 * The paging loop for (2) is `collectDirectoryEntries` from
 * `@valet/plugin-github/repo-contents`, the module behind
 * `github.list_repo_directory`. Only the transport differs: the plugin action
 * builds an Octokit from the caller's stored credential, and this reader
 * sends no credential at all.
 *
 * PUBLIC REPOSITORIES ONLY. Nothing here resolves a GitHub token, and that is
 * deliberate rather than unfinished. Reading a private repository would go
 * through the org's GitHub App installation, which can reach every repository
 * the org installed it on — so an authenticated importer needs a check that
 * the person adding the source may read that repository, and no such check
 * exists anywhere in this codebase yet. Until it does, the App's reach must
 * not sit behind an "add a repository" box. See
 * docs/specs/2026-08-05-agent-skills-design.md.
 *
 * Unauthenticated GitHub allows 60 requests per hour per IP. That budget is
 * why `services/skill-sync.ts` polls on a long interval and stops after one
 * call when the head commit has not moved.
 */
import {
  collectDirectoryEntries,
  MAX_DIRECTORY_ENTRIES,
  type ContentsRequestParams,
  type DirectoryEntry,
} from "@valet/plugin-github/repo-contents";
import { resolveGithubApiUrl } from "./github-env.js";

/** Thrown when GitHub reports the repository or ref as missing. Unauthenticated,
 * a private repository and a misspelled name are the same 404. */
export class SkillRepoNotFoundError extends Error {
  readonly code = "skill_repo_not_found";
  readonly statusCode = 404;
  constructor(repoFullName: string) {
    super(
      `${repoFullName} was not found on GitHub. Valet reads public repositories only, so a private repository and a misspelled name look the same here. Check the name for a spelling mistake. If the repository is private, make it public.`,
    );
    this.name = "SkillRepoNotFoundError";
  }
}

/** Thrown for any other unhappy response. Separate from the 404 so a sync
 * failure caused by a GitHub fault never reads as "the repository is gone". */
export class SkillRepoReadError extends Error {
  readonly code = "skill_repo_read_failed";
  readonly statusCode = 502;
  constructor(what: string, status: number, detail: string) {
    super(`GitHub returned ${status} for ${what}. ${detail}`.trim());
    this.name = "SkillRepoReadError";
  }
}

export interface SkillDirectoryListing {
  entries: DirectoryEntry[];
  /** False when the directory holds more entries than one read returns. */
  complete: boolean;
}

/** What skill sync needs from a repository host. One implementation ships
 * (`PublicSkillRepoReader`); tests point it at a fixture server. */
export interface SkillRepoReader {
  /** Commit the ref points at. An empty ref means the default branch. */
  headSha(repoFullName: string, ref: string): Promise<string>;
  /** One level of `path`. Pass a commit as `ref` to pin the read. */
  listDirectory(repoFullName: string, path: string, ref: string): Promise<SkillDirectoryListing>;
  /** File body, or null when the path holds no file. */
  readFile(repoFullName: string, path: string, ref: string): Promise<string | null>;
}

export interface PublicSkillRepoReaderOptions {
  /** GitHub API base URL. Defaults to `resolveGithubApiUrl(process.env)`,
   * read at construction time. Tests pass a fixture's URL. */
  apiUrl?: string;
  /** Injected for tests that need to fail the transport itself. */
  fetchImpl?: typeof fetch;
}

/**
 * The ref used when a source tracks the default branch. GitHub resolves
 * `HEAD` to the default branch's tip, so this costs one call instead of a
 * repository read followed by a commit read.
 */
const DEFAULT_REF = "HEAD";

export class PublicSkillRepoReader implements SkillRepoReader {
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PublicSkillRepoReaderOptions = {}) {
    this.apiUrl = (opts.apiUrl ?? resolveGithubApiUrl(process.env)).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async headSha(repoFullName: string, ref: string): Promise<string> {
    const target = ref.length > 0 ? ref : DEFAULT_REF;
    const url = `${this.apiUrl}/repos/${encodePath(repoFullName)}/commits/${encodePath(target)}`;
    const data = await this.getJson(url, repoFullName, `${repoFullName}@${target}`);
    const sha = isRecord(data) ? data.sha : undefined;
    if (typeof sha !== "string" || sha.length === 0) {
      throw new SkillRepoReadError(
        `${repoFullName}@${target}`,
        200,
        "The commit response carried no sha. Retry the sync.",
      );
    }
    return sha;
  }

  async listDirectory(
    repoFullName: string,
    path: string,
    ref: string,
  ): Promise<SkillDirectoryListing> {
    const [owner = "", repo = ""] = repoFullName.split("/");
    const listing = await collectDirectoryEntries(
      this.contentsRequest(),
      { owner, repo, path, ref },
      MAX_DIRECTORY_ENTRIES,
    );
    if (listing.kind !== "directory") {
      throw new SkillRepoReadError(
        `${repoFullName}/${path}`,
        200,
        `That path is a ${listing.type}, not a directory. Point the source at the directory that holds the skill directories.`,
      );
    }
    return { entries: listing.entries, complete: listing.complete };
  }

  async readFile(repoFullName: string, path: string, ref: string): Promise<string | null> {
    const url = this.contentsUrl(repoFullName, path, { ref });
    const res = await this.fetchImpl(url, { headers: HEADERS });
    if (res.status === 404) return null;
    const data = await this.readBody(res, repoFullName, `${repoFullName}/${path}`);
    if (!isRecord(data) || data.type !== "file") return null;
    const raw = typeof data.content === "string" ? data.content : "";
    if (data.encoding !== "base64") return raw;
    return Buffer.from(raw.replace(/\n/g, ""), "base64").toString("utf8");
  }

  /** The `ContentsRequest` seam `collectDirectoryEntries` drives. */
  private contentsRequest() {
    return async (params: ContentsRequestParams): Promise<{ data: unknown }> => {
      const repoFullName = `${params.owner}/${params.repo}`;
      const url = this.contentsUrl(repoFullName, params.path, {
        ref: params.ref,
        per_page: String(params.per_page),
        page: String(params.page),
      });
      const res = await this.fetchImpl(url, { headers: HEADERS });
      const data = await this.readBody(res, repoFullName, `${repoFullName}/${params.path}`);
      return { data };
    };
  }

  private contentsUrl(
    repoFullName: string,
    path: string,
    query: Record<string, string | undefined>,
  ): string {
    // The trailing slash is kept for an empty path: `contents/` is how the
    // contents endpoint addresses the repository root.
    const url = new URL(`${this.apiUrl}/repos/${encodePath(repoFullName)}/contents/${encodePath(path)}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value.length > 0) url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private async getJson(url: string, repoFullName: string, what: string): Promise<unknown> {
    const res = await this.fetchImpl(url, { headers: HEADERS });
    return this.readBody(res, repoFullName, what);
  }

  private async readBody(res: Response, repoFullName: string, what: string): Promise<unknown> {
    if (res.status === 404) throw new SkillRepoNotFoundError(repoFullName);
    if (!res.ok) {
      throw new SkillRepoReadError(what, res.status, await githubMessage(res));
    }
    return res.json();
  }
}

const HEADERS: Record<string, string> = {
  accept: "application/vnd.github+json",
  "user-agent": "Valet",
  "x-github-api-version": "2022-11-28",
};

/** Percent-encodes each path segment and keeps the separators. */
function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function githubMessage(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  const message = isRecord(body) && typeof body.message === "string" ? body.message : "";
  return message.length > 0 ? `${message} Retry the sync.` : "Retry the sync.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
