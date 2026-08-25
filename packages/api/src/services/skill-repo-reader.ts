/**
 * Reads a GitHub repository for skill sync. Four operations:
 *
 *   1. `head`          — `GET /repos/{owner}/{repo}/commits/{ref}`
 *   2. `listTree`      — `GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1`
 *   3. `listDirectory` — `GET /repos/{owner}/{repo}/contents/{path}`
 *   4. `readFile`      — the same contents endpoint, on a file path
 *
 * (2) is how skill sync finds the skills. One recursive tree read returns
 * every path in the repository, so sync no longer needs to be told which
 * directory holds the skills, and no longer spends one request per candidate
 * directory to find out. (3) stays for the one case (2) cannot serve: a
 * repository large enough for GitHub to cut the tree.
 *
 * The paging loop for (3) is `collectDirectoryEntries` from
 * `@valet/plugin-github/repo-contents`, the module behind
 * `github.list_repo_directory`. Only the transport differs: the plugin action
 * builds an Octokit from the caller's stored credential, and this reader
 * sends one bearer token, or none.
 *
 * ## The reader does not choose the credential
 *
 * `services/content-source-credential.ts` makes that choice from the source
 * row's owner, and this class carries only what it is given. The two stay
 * apart on purpose: reading a private repository through the wrong
 * credential is a privilege escalation, so the rule that picks one must live
 * in a single function a reviewer can check on its own.
 *
 * ## No credential is a supported state
 *
 * With no credential the reader sends no `Authorization` header, and every
 * public repository stays readable exactly as before. Nobody has to connect
 * GitHub to track a public repository.
 *
 * ## A token goes in the header and nowhere else
 *
 * `content_sources.last_error` holds this module's error text, and the product
 * shows that column to every reader of the source. So a token must never
 * reach an error message, a log line, a query string, or the database. The
 * reader keeps the token inside its own header map and keeps only the KIND
 * of the credential for the messages below.
 *
 * ## Rate limits
 *
 * Anonymous GitHub allows 60 requests per hour per IP; an authenticated
 * request gets 5000. `services/content-sync/service.ts` polls on a long interval and
 * stops after one call when the head commit has not moved, which is what
 * keeps the anonymous budget workable.
 */
import {
  collectDirectoryEntries,
  MAX_DIRECTORY_ENTRIES,
  type ContentsRequestParams,
  type DirectoryEntry,
} from "@valet/plugin-github/repo-contents";
import { resolveGithubApiUrl } from "./github-env.js";

/** Who reads the source row, relative to the person whose credential the
 * sync uses. On a personal source they are the same person. On a team source
 * they are usually not, and the 404 message must name an action the READER
 * can do. */
export type SkillRepoOwnerScope = "user" | "team";

/**
 * What the reader knows about the credential for one read. All four states
 * are here, because each names a different corrective action in a 404 and
 * the reader must not merge them:
 *
 *   - `none`        — the source has no credential to use. Read anonymously.
 *   - `unavailable` — a credential exists but the server cannot read it.
 *                     Also read anonymously, but say something different.
 *   - `user`        — one person's own GitHub credential.
 *   - `installation`— the org's GitHub App installation token.
 *
 * `token` is used in the `Authorization` header and is read nowhere else.
 */
export type SkillRepoCredential =
  | { kind: "none" }
  | { kind: "unavailable" }
  | {
      kind: "user";
      token: string;
      /** Which owner the source has, which decides who reads its errors. */
      ownerScope: SkillRepoOwnerScope;
      /** GitHub login behind the credential, when it is known. Printed only
       * for a personal source — see `correctiveAction`. */
      login?: string;
    }
  | { kind: "installation"; token: string };

/** What a read can say about the credential it used: `SkillRepoCredential`
 * without its token. Its own type because this shape reaches error messages,
 * and those are published on the source row for everyone who can see it. */
export type SkillRepoCredentialDescriptor =
  | { kind: "none" }
  | { kind: "unavailable" }
  | { kind: "user"; ownerScope: SkillRepoOwnerScope; login?: string }
  | { kind: "installation" };

/** Drops the token. Written as a switch rather than a rest-spread so that a
 * new credential field cannot reach an error message by default: adding one
 * to `SkillRepoCredential` breaks this function until somebody decides
 * whether it is safe to publish. */
export function describeCredential(
  credential: SkillRepoCredential,
): SkillRepoCredentialDescriptor {
  switch (credential.kind) {
    case "user":
      return credential.login === undefined
        ? { kind: "user", ownerScope: credential.ownerScope }
        : { kind: "user", ownerScope: credential.ownerScope, login: credential.login };
    case "installation":
      return { kind: "installation" };
    default:
      return { kind: credential.kind };
  }
}

/**
 * GitHub answers 404 both for a repository that is not there and for one the
 * credential cannot see, so it cannot tell the two apart for us. Valet knows
 * locally which credential the read used, and that is what decides which
 * real case the reader reports.
 *
 * ## The message must fit the person who READS it
 *
 * This text goes to `content_sources.last_error`, and the product shows that
 * column to everyone who can see the source. On a personal source the reader
 * and the credential holder are the same person, so "get access to the
 * repository" is an action they can do. On a TEAM source they are usually
 * different people: the sync keeps using the credential of the person who
 * added the row, so a teammate who gets access to the repository changes
 * nothing. The team message therefore names the two actions that do work —
 * ask the person who added the source, or add the source again yourself.
 *
 * The team message also names no GitHub login. A login identifies one person
 * on a row that otherwise names nobody, and the team reader does not need it
 * to do either action.
 */
function correctiveAction(credential: SkillRepoCredentialDescriptor): string {
  if (credential.kind === "user" && credential.ownerScope === "team") {
    return "Valet read it with the GitHub account that added this source. That account cannot see the repository, or the name has a spelling mistake. Ask the person who added the source to get access on GitHub, or add the source again yourself.";
  }
  if (credential.kind === "user") {
    const account =
      credential.login === undefined
        ? "the connected GitHub account"
        : `the GitHub account ${credential.login}`;
    return `Valet read it with ${account}. That account cannot see the repository, or the name has a spelling mistake. Get access to the repository on GitHub, then sync again.`;
  }
  if (credential.kind === "installation") {
    return "Valet read it with the GitHub App installed for this organization. Add the repository to the App installation on GitHub, then sync again.";
  }
  if (credential.kind === "unavailable") {
    return "Valet has a GitHub credential for this source but cannot read it. This occurs after a change to the server encryption key. Connect GitHub again in Settings → Connected accounts, then sync again.";
  }
  return "Valet read it with no GitHub credential. To read a private repository, connect GitHub in Settings → Connected accounts, then sync again. If the repository is public, check the name for a spelling mistake.";
}

/** Thrown when GitHub reports the repository or ref as missing. The message
 * names which credential the read used, because that is what decides what
 * the reader must do next — see `correctiveAction`. */
export class SkillRepoNotFoundError extends Error {
  readonly code = "skill_repo_not_found";
  readonly statusCode = 404;
  constructor(
    repoFullName: string,
    credential: SkillRepoCredentialDescriptor = { kind: "none" },
  ) {
    super(`${repoFullName} was not found on GitHub. ${correctiveAction(credential)}`);
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

/** Thrown when a directory holds more entries than the reader collects. Its
 * own class because the reader can name the cut and the caller cannot: skill
 * sync reads "absent from the listing" as "deleted upstream", so it must fail
 * here rather than mirror from a partial listing. */
export class SkillRepoListingTruncatedError extends Error {
  readonly code = "skill_repo_listing_truncated";
  readonly statusCode = 400;
  constructor(repoFullName: string, path: string) {
    const where = path.length > 0 ? `${repoFullName}/${path}` : repoFullName;
    super(
      `${where} holds ${MAX_DIRECTORY_ENTRIES} entries or more, so Valet read part of its listing. Nothing was imported, updated, or deleted: the entries left out look exactly like skills removed from the repository. Remove this repository, then import the /tree/ URL of the directory that holds the skill directories.`,
    );
    this.name = "SkillRepoListingTruncatedError";
  }
}

/**
 * Thrown when GitHub cut the recursive tree. GitHub returns at most 100,000
 * tree entries, or 7 MB, and reports the cut as `truncated: true`.
 *
 * Its own class, and a failure rather than a warning, for the reason
 * `SkillRepoListingTruncatedError` gives: skill sync reads "absent from the
 * listing" as "deleted upstream", so a cut tree must never reconcile.
 *
 * Sync throws this only when the source tracks the whole repository. A source
 * that names a subdirectory has somewhere smaller to look, so sync reads that
 * directory through the contents endpoint instead of failing.
 */
export class SkillRepoTreeTruncatedError extends Error {
  readonly code = "skill_repo_tree_truncated";
  readonly statusCode = 400;
  constructor(repoFullName: string) {
    super(
      `${repoFullName} holds more files than Valet can read in one listing, so Valet read part of it. Nothing was imported, updated, or deleted: the files left out look exactly like skills removed from the repository. Set the subdirectory that holds the skills, by importing its /tree/ URL.`,
    );
    this.name = "SkillRepoTreeTruncatedError";
  }
}

/**
 * Thrown when the configured subdirectory is not in the tree at this commit.
 *
 * A failure, not an empty result, and it is the one guard that survived the
 * move to the tree read. The contents endpoint answered 404 for a
 * subdirectory that was renamed, moved, or misspelled, so the sync failed
 * and the mirrored rows were kept for the next attempt. A tree read answers
 * the whole repository instead, so the same mistake now looks like "the
 * directory is there and holds no skill" — and reconcile deletes every
 * mirrored row on the strength of it.
 *
 * The message names both actions, because the reader does not know which
 * happened: the branch can be wrong, or the directory can have moved.
 */
export class SkillRepoSubpathNotFoundError extends Error {
  readonly code = "skill_repo_subpath_not_found";
  readonly statusCode = 404;
  constructor(repoFullName: string, subpath: string, ref: string) {
    const where = ref.length > 0 ? ref : "the default branch";
    super(
      `${repoFullName} has no directory ${subpath} on ${where}. Nothing was imported, updated, or deleted, so the skills already mirrored from this source are still here. Check the branch, or remove the source and import the repository again without a subdirectory.`,
    );
    this.name = "SkillRepoSubpathNotFoundError";
  }
}

/**
 * Thrown when one commit holds more skill files than one sync reads.
 *
 * The tree read costs one request, but each skill file costs one more, and
 * those run one after the other. `MAX_SKILL_CANDIDATES` explains the number.
 * A failure rather than a partial import, for the reason
 * `SkillRepoListingTruncatedError` gives: importing the first N of a list
 * and reconciling makes every file past N look deleted upstream.
 */
export class SkillRepoTooManySkillsError extends Error {
  readonly code = "skill_repo_too_many_skills";
  readonly statusCode = 400;
  constructor(repoFullName: string, found: number, limit: number) {
    super(
      `${repoFullName} holds ${found} ${SKILL_FILE_NAME} files, and Valet reads at most ${limit} in one sync. Nothing was imported, updated, or deleted: the files left out look exactly like skills removed from the repository. Remove this repository, then import the /tree/ URL of the directory that holds the skills.`,
    );
    this.name = "SkillRepoTooManySkillsError";
  }
}

/** The file name in the message above. Kept here rather than imported from
 * `skill-discovery.ts`, so the error module does not depend on the module
 * that throws it. */
const SKILL_FILE_NAME = "SKILL.md";

/** Thrown when a request passed `REQUEST_TIMEOUT_MS`. Separate from
 * `SkillRepoReadError` because no response arrived to carry a status. */
export class SkillRepoTimeoutError extends Error {
  readonly code = "skill_repo_timeout";
  readonly statusCode = 504;
  constructor(what: string, timeoutMs: number) {
    super(
      `GitHub did not answer for ${what} within ${timeoutMs} ms. The sync stopped, and the next poll reads the repository again. If every sync times out, check GitHub's status page.`,
    );
    this.name = "SkillRepoTimeoutError";
  }
}

export interface SkillDirectoryListing {
  entries: DirectoryEntry[];
  /** False when the directory holds more entries than one read returns. */
  complete: boolean;
}

/** A commit and the tree it holds, from one commit read. */
export interface SkillRepoHead {
  /** The commit itself. This is what sync stores as `last_sha`. */
  sha: string;
  /** `commit.tree.sha`. GitHub's tree endpoint documents a TREE sha as its
   * input, so the tree read passes this rather than the commit sha. */
  treeSha: string;
}

/** One entry of a recursive tree read. */
export interface SkillTreeEntry {
  /** Path from the repository root. Never has a leading slash. */
  path: string;
  /** `blob` for a file, `tree` for a directory. */
  type: string;
  /** Git file mode. `120000` is a symlink, whose blob holds a path string
   * rather than the file it points at. */
  mode: string;
  /** Blob or tree sha. For a blob this is the content identity, which is
   * what lets sync compare a file without reading it. */
  sha: string;
}

export interface SkillTreeListing {
  entries: SkillTreeEntry[];
  /** True when GitHub cut the tree. See `SkillRepoTreeTruncatedError`. */
  truncated: boolean;
}

/** One file, with the identity the tree read also carries. */
export interface SkillRepoFile {
  text: string;
  /** Git blob sha. Equal to the `sha` of the same path's tree entry, so a
   * file read through either path produces the same manifest. */
  blobSha: string;
}

/** What skill sync needs from a repository host. One implementation ships
 * (`GitHubSkillRepoReader`); tests point it at a fixture server. */
export interface SkillRepoReader {
  /** Commit the ref points at, and its tree. An empty ref means the default
   * branch. */
  head(repoFullName: string, ref: string): Promise<SkillRepoHead>;
  /** Every path under `treeSha`, in one request. */
  listTree(repoFullName: string, treeSha: string): Promise<SkillTreeListing>;
  /** One level of `path`. Pass a commit as `ref` to pin the read. */
  listDirectory(repoFullName: string, path: string, ref: string): Promise<SkillDirectoryListing>;
  /** File body and blob sha, or null when the path holds no file. */
  readFile(repoFullName: string, path: string, ref: string): Promise<SkillRepoFile | null>;
}

export interface GitHubSkillRepoReaderOptions {
  /** GitHub API base URL. Defaults to `resolveGithubApiUrl(process.env)`,
   * read at construction time. Tests pass a fixture's URL. */
  apiUrl?: string;
  /** Injected for tests that need to fail the transport itself. */
  fetchImpl?: typeof fetch;
  /** Deadline for one request. Defaults to `REQUEST_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** The credential for every request this reader makes. A `user` or
   * `installation` credential becomes the `Authorization` header. `none` and
   * `unavailable` send no header and read anonymously, which is what a public
   * repository needs. Omitting it means `none`. */
  credential?: SkillRepoCredential;
}

/**
 * The ref used when a source tracks the default branch. GitHub resolves
 * `HEAD` to the default branch's tip, so this costs one call instead of a
 * repository read followed by a commit read.
 */
const DEFAULT_REF = "HEAD";

/**
 * Deadline for one GitHub request. A hung connection must not pin the sweep:
 * `ContentSyncService.pollOnce` holds its `draining` flag for a whole pass, so
 * one stalled read stops every other source from syncing until the socket
 * gives up on its own.
 */
const REQUEST_TIMEOUT_MS = 15_000;

export class GitHubSkillRepoReader implements SkillRepoReader {
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  /** Built per instance, not shared, because the `Authorization` header
   * belongs to this reader's credential alone. Nothing outside `get` reads
   * this map, which is what keeps the token off every other surface. */
  private readonly headers: Record<string, string>;
  /** The credential WITHOUT its token, for `SkillRepoNotFoundError`. */
  private readonly credential: SkillRepoCredentialDescriptor;

  constructor(opts: GitHubSkillRepoReaderOptions = {}) {
    this.apiUrl = (opts.apiUrl ?? resolveGithubApiUrl(process.env)).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const credential: SkillRepoCredential = opts.credential ?? { kind: "none" };
    this.headers = { ...BASE_HEADERS };
    if (credential.kind === "user" || credential.kind === "installation") {
      this.headers.authorization = `Bearer ${credential.token}`;
    }
    this.credential = describeCredential(credential);
  }

  async head(repoFullName: string, ref: string): Promise<SkillRepoHead> {
    const target = ref.length > 0 ? ref : DEFAULT_REF;
    const url = `${this.apiUrl}/repos/${encodePath(repoFullName)}/commits/${encodePath(target)}`;
    const what = `${repoFullName}@${target}`;
    const data = await this.getJson(url, repoFullName, what);
    const sha = isRecord(data) ? data.sha : undefined;
    if (typeof sha !== "string" || sha.length === 0) {
      throw new SkillRepoReadError(what, 200, "The commit response carried no sha. Retry the sync.");
    }
    // The tree sha comes free with the commit, which is why discovery costs
    // no extra request. Every commit carries one, so an absent value is a
    // malformed response and not a repository state.
    const commit = isRecord(data) && isRecord(data.commit) ? data.commit : undefined;
    const tree = commit !== undefined && isRecord(commit.tree) ? commit.tree : undefined;
    const treeSha = tree?.sha;
    if (typeof treeSha !== "string" || treeSha.length === 0) {
      throw new SkillRepoReadError(what, 200, "The commit response carried no tree sha. Retry the sync.");
    }
    return { sha, treeSha };
  }

  async listTree(repoFullName: string, treeSha: string): Promise<SkillTreeListing> {
    const url = new URL(
      `${this.apiUrl}/repos/${encodePath(repoFullName)}/git/trees/${encodePath(treeSha)}`,
    );
    url.searchParams.set("recursive", "1");
    const what = `${repoFullName} tree ${treeSha}`;
    const data = await this.getJson(url.toString(), repoFullName, what);
    if (!isRecord(data) || !Array.isArray(data.tree)) {
      throw new SkillRepoReadError(what, 200, "The tree response carried no entries. Retry the sync.");
    }
    const entries: SkillTreeEntry[] = [];
    for (const raw of data.tree) {
      if (!isRecord(raw)) continue;
      const { path, type, mode, sha } = raw;
      if (typeof path !== "string" || typeof type !== "string" || typeof sha !== "string") continue;
      entries.push({ path, type, mode: typeof mode === "string" ? mode : "", sha });
    }
    return { entries, truncated: data.truncated === true };
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
        `That path is a ${listing.type}, not a directory. Set the source subdirectory to a directory in the repository, or remove it to scan the whole repository.`,
      );
    }
    return { entries: listing.entries, complete: listing.complete };
  }

  async readFile(repoFullName: string, path: string, ref: string): Promise<SkillRepoFile | null> {
    const url = this.contentsUrl(repoFullName, path, { ref });
    const what = `${repoFullName}/${path}`;
    const res = await this.get(url, what);
    if (res.status === 404) return null;
    const data = await this.readBody(res, repoFullName, what);
    if (!isRecord(data) || data.type !== "file") return null;
    const raw = typeof data.content === "string" ? data.content : "";
    const text =
      data.encoding === "base64"
        ? Buffer.from(raw.replace(/\n/g, ""), "base64").toString("utf8")
        : raw;
    // The blob sha is the manifest key, so a response without one cannot be
    // mirrored: two different versions of the file would hash the same and
    // the sync would report no change. GitHub sends `sha` on every file.
    if (typeof data.sha !== "string" || data.sha.length === 0) {
      throw new SkillRepoReadError(what, 200, "The file response carried no sha. Retry the sync.");
    }
    return { text, blobSha: data.sha };
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
      const what = `${repoFullName}/${params.path}`;
      const res = await this.get(url, what);
      const data = await this.readBody(res, repoFullName, what);
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
    const res = await this.get(url, what);
    return this.readBody(res, repoFullName, what);
  }

  /** The one place a request leaves this reader, so every read carries the
   * timeout. This reader owns the only signal on the request, which is why
   * an abort here can only be that timeout. */
  private async get(url: string, what: string): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        headers: this.headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new SkillRepoTimeoutError(what, this.timeoutMs);
      }
      throw err;
    }
  }

  private async readBody(res: Response, repoFullName: string, what: string): Promise<unknown> {
    if (res.status === 404) throw new SkillRepoNotFoundError(repoFullName, this.credential);
    if (!res.ok) {
      throw new SkillRepoReadError(what, res.status, await githubMessage(res));
    }
    return res.json();
  }
}

/** Copied into each reader's own header map, which then adds the
 * `Authorization` header when the reader carries a credential. */
const BASE_HEADERS: Record<string, string> = {
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
