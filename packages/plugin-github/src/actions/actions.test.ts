/**
 * Action suites that exercise the real HTTP request each action sends.
 *
 * `startGithubFixture` serves a fake GitHub API on a loopback port and
 * `GITHUB_API_URL` points the plugin's Octokit at it, so these tests assert on
 * the method, path, query, and body the action actually produced — not on a
 * mocked Octokit method name.
 */
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginAction } from "@valet/engine";
import { githubPlugin } from "./actions.js";
import { fakeActionContext } from "../test-helpers/action-context.js";
import {
  startGithubFixture,
  type GithubFixture,
  type GithubFixtureCall,
  type GithubFixtureHandlers,
} from "../test-helpers/github-fixture.js";

const prevGithubApiUrl = process.env.GITHUB_API_URL;
let fixture: GithubFixture | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  if (prevGithubApiUrl === undefined) delete process.env.GITHUB_API_URL;
  else process.env.GITHUB_API_URL = prevGithubApiUrl;
});

/** Starts the fixture and points the plugin's Octokit at it. */
function useFixture(handlers: GithubFixtureHandlers = {}): GithubFixture {
  fixture = startGithubFixture(handlers);
  process.env.GITHUB_API_URL = fixture.url;
  return fixture;
}

function findAction(id: string): PluginAction {
  const action = githubPlugin.actions.find((a) => a.id === id);
  if (!action) throw new Error(`no action with id ${id}`);
  return action;
}

describe("github action base URL", () => {
  it("sends requests to GITHUB_API_URL when it is set", async () => {
    const server = useFixture();

    const result = await findAction("github.get_repository").execute(
      { owner: "acme", repo: "widgets" },
      fakeActionContext("test-token"),
    );

    expect(result.success).toBe(true);
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /repos/acme/widgets"]);
    expect(server.calls[0].authHeader).toContain("test-token");
  });
});

// ─── list_repos credential scope ────────────────────────────────────────────

describe("github.list_repos credential scope", () => {
  it("switches to the installation token for scope=installation when the host resolves one", async () => {
    const server = useFixture();

    const result = await findAction("github.list_repos").execute(
      { scope: "installation" },
      fakeActionContext("user-token", { "github:installation": "installation-token" }),
    );

    expect(result.success).toBe(true);
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /installation/repositories",
    ]);
    expect(server.calls[0].authHeader).toContain("installation-token");
    expect(server.calls[0].authHeader).not.toContain("user-token");
  });

  it("falls back to the default credential when the host resolves no installation token", async () => {
    const server = useFixture();

    const result = await findAction("github.list_repos").execute(
      { scope: "installation" },
      fakeActionContext("default-token"),
    );

    expect(result.success).toBe(true);
    expect(server.calls[0].authHeader).toContain("default-token");
  });

  it("uses the installation token for the auto fallback after a 403 from /user/repos", async () => {
    const server = useFixture({
      listUserRepos: () => ({ status: 403, body: { message: "Resource not accessible by integration" } }),
    });

    const result = await findAction("github.list_repos").execute(
      {},
      fakeActionContext("user-token", { "github:installation": "installation-token" }),
    );

    expect(result.success).toBe(true);
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /user/repos",
      "GET /installation/repositories",
    ]);
    expect(server.calls[1].authHeader).toContain("installation-token");
  });

  it("names the corrective step when the installation listing still gets a 403", async () => {
    useFixture({
      listInstallationRepos: () => ({ status: 403, body: { message: "Resource not accessible by integration" } }),
    });

    const result = await findAction("github.list_repos").execute(
      { scope: "installation" },
      fakeActionContext("user-token"),
    );

    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.error).toContain("Install the GitHub App");
  });
});

// ─── inspect_pull_request ───────────────────────────────────────────────────

interface InspectFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  patch_truncated?: boolean;
  patch_omitted?: string;
}

interface InspectData {
  number: number;
  files: InspectFile[];
  matched_file_count: number;
  files_complete: boolean;
  patch_summary?: {
    limit_bytes: number;
    included_bytes: number;
    truncated_files: number;
    omitted_files: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberAt(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") throw new Error(`${key} is not a number: ${JSON.stringify(value)}`);
  return value;
}

/** Narrows `PluginActionResult.data` without a cast: every field the suite
 * reads is checked, so a shape change fails here with a readable message. */
function asInspectData(data: unknown): InspectData {
  if (!isRecord(data)) throw new Error(`not an object: ${JSON.stringify(data)}`);
  const files = data.files;
  if (!Array.isArray(files)) throw new Error("missing files array");
  if (typeof data.matched_file_count !== "number") throw new Error("missing matched_file_count");
  if (typeof data.files_complete !== "boolean") throw new Error("missing files_complete");
  const summary = data.patch_summary;

  return {
    number: numberAt(data, "number"),
    files: files.map((file: unknown) => {
      if (!isRecord(file)) throw new Error("file entry is not an object");
      return {
        filename: String(file.filename),
        status: String(file.status),
        additions: numberAt(file, "additions"),
        deletions: numberAt(file, "deletions"),
        patch: typeof file.patch === "string" ? file.patch : undefined,
        patch_truncated: typeof file.patch_truncated === "boolean" ? file.patch_truncated : undefined,
        patch_omitted: typeof file.patch_omitted === "string" ? file.patch_omitted : undefined,
      };
    }),
    matched_file_count: data.matched_file_count,
    files_complete: data.files_complete,
    patch_summary: isRecord(summary)
      ? {
          limit_bytes: numberAt(summary, "limit_bytes"),
          included_bytes: numberAt(summary, "included_bytes"),
          truncated_files: numberAt(summary, "truncated_files"),
          omitted_files: numberAt(summary, "omitted_files"),
        }
      : undefined,
  };
}

/** A patch of `lines` lines, each exactly 50 bytes including the newline. */
function patchOf(lines: number, marker: string): string {
  const rows: string[] = [];
  for (let i = 0; i < lines; i++) {
    rows.push(`+${marker}${String(i).padStart(3, "0")}`.padEnd(49, "x"));
  }
  return rows.join("\n") + "\n";
}

function fileEntry(filename: string, patch?: string): Record<string, unknown> {
  return { filename, status: "modified", additions: 1, deletions: 0, ...(patch === undefined ? {} : { patch }) };
}

async function inspectRaw(args: Record<string, unknown>): Promise<unknown> {
  const result = await findAction("github.inspect_pull_request").execute(
    { owner: "acme", repo: "widgets", pullNumber: 7, ...args },
    fakeActionContext("test-token"),
  );
  if (!result.success) throw new Error(`inspect failed: ${result.error}`);
  return result.data;
}

async function inspect(args: Record<string, unknown>): Promise<InspectData> {
  return asInspectData(await inspectRaw(args));
}

/** The three lists that say a pull request already belongs to somebody. */
interface ReviewerClaim {
  requested_reviewers: string[];
  requested_teams: string[];
  assignees: string[];
}

function stringsAt(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`${key} is not an array: ${JSON.stringify(value)}`);
  return value.map((entry) => {
    if (typeof entry !== "string") throw new Error(`${key} holds a non-string: ${JSON.stringify(entry)}`);
    return entry;
  });
}

function asReviewerClaim(data: unknown): ReviewerClaim {
  if (!isRecord(data)) throw new Error(`not an object: ${JSON.stringify(data)}`);
  return {
    requested_reviewers: stringsAt(data, "requested_reviewers"),
    requested_teams: stringsAt(data, "requested_teams"),
    assignees: stringsAt(data, "assignees"),
  };
}

/** Serves `files` as real pages, honouring `per_page` and `page`. */
function pagedFiles(files: Record<string, unknown>[]): GithubFixtureHandlers["listPullFiles"] {
  return (_ref, query) => {
    const perPage = Number(query.per_page ?? "30");
    const page = Number(query.page ?? "1");
    const start = (page - 1) * perPage;
    return { body: files.slice(start, start + perPage) };
  };
}

function pullWith(changedFiles: number): GithubFixtureHandlers["getPull"] {
  return (ref) => ({
    body: {
      number: Number(ref.pullNumber),
      title: "fixture pull request",
      state: "open",
      user: { login: "fixture-user" },
      html_url: "https://github.com/acme/widgets/pull/7",
      head: { ref: "feature", sha: "head-sha" },
      base: { ref: "main" },
      additions: changedFiles,
      deletions: 0,
      changed_files: changedFiles,
    },
  });
}

describe("github.inspect_pull_request diff retrieval", () => {
  const FILES = [
    fileEntry("source/rest/handler.go", patchOf(20, "a")),
    fileEntry("source/grpc/server.go", patchOf(20, "b")),
    fileEntry("docs/readme.md", patchOf(20, "c")),
  ];

  it("omits patches unless includePatch is set", async () => {
    useFixture({ getPull: pullWith(3), listPullFiles: pagedFiles(FILES) });

    const data = await inspect({});

    expect(data.files.map((f) => f.filename)).toEqual([
      "source/rest/handler.go",
      "source/grpc/server.go",
      "docs/readme.md",
    ]);
    expect(data.files.every((f) => f.patch === undefined)).toBe(true);
    expect(data.patch_summary).toBeUndefined();
  });

  it("passes each file's patch through when includePatch is set", async () => {
    useFixture({ getPull: pullWith(3), listPullFiles: pagedFiles(FILES) });

    const data = await inspect({ includePatch: true });

    expect(data.files[0].patch).toBe(patchOf(20, "a"));
    expect(data.files.every((f) => f.patch_truncated === undefined)).toBe(true);
    expect(data.patch_summary?.truncated_files).toBe(0);
    expect(data.patch_summary?.omitted_files).toBe(0);
    expect(data.patch_summary?.included_bytes).toBe(3000);
  });

  it("makes byte-cap truncation visible in the file entry and the summary", async () => {
    useFixture({ getPull: pullWith(3), listPullFiles: pagedFiles(FILES) });

    // 1500 bytes: file 1 fits whole (1000), file 2 keeps 10 of 20 lines, file 3
    // gets nothing.
    const data = await inspect({ includePatch: true, patchBytesLimit: 1500 });

    expect(data.files[0].patch_truncated).toBeUndefined();
    expect(data.files[1].patch_truncated).toBe(true);
    expect(data.files[1].patch).toContain("truncated");
    expect(data.files[1].patch?.split("\n")[0]).toBe(patchOf(20, "b").split("\n")[0]);
    expect(data.files[2].patch).toBeUndefined();
    expect(data.files[2].patch_omitted).toBe("byte_budget");
    expect(data.patch_summary).toEqual({
      limit_bytes: 1500,
      included_bytes: 1500,
      truncated_files: 1,
      omitted_files: 1,
    });
  });

  it("marks files GitHub itself sent no patch for", async () => {
    useFixture({
      getPull: pullWith(2),
      listPullFiles: pagedFiles([fileEntry("logo.png"), fileEntry("source/rest/handler.go", patchOf(2, "a"))]),
    });

    const data = await inspect({ includePatch: true });

    expect(data.files[0].patch_omitted).toBe("not_provided_by_github");
    expect(data.files[1].patch).toBeDefined();
    expect(data.patch_summary?.omitted_files).toBe(1);
  });
});

describe("github.inspect_pull_request reviewer claim", () => {
  /** One pull request, with whatever claim fields a case wants on it. */
  function pullClaiming(claim: Record<string, unknown>): GithubFixtureHandlers["getPull"] {
    return (ref) => ({
      body: {
        number: Number(ref.pullNumber),
        title: "fixture pull request",
        state: "open",
        user: { login: "fixture-user" },
        html_url: "https://github.com/acme/widgets/pull/7",
        head: { ref: "feature", sha: "head-sha" },
        base: { ref: "main" },
        additions: 1,
        deletions: 0,
        changed_files: 1,
        ...claim,
      },
    });
  }

  it("reports who is already requested or assigned, as names", async () => {
    useFixture({
      getPull: pullClaiming({
        requested_reviewers: [{ login: "first-account" }, { login: "second-account" }],
        requested_teams: [{ slug: "platform" }],
        assignees: [{ login: "first-account" }],
      }),
      listPullFiles: pagedFiles([fileEntry("source/rest/handler.go")]),
    });

    expect(asReviewerClaim(await inspectRaw({}))).toEqual({
      requested_reviewers: ["first-account", "second-account"],
      requested_teams: ["platform"],
      assignees: ["first-account"],
    });
  });

  it("reports an unclaimed pull request as empty lists, not as absent fields", async () => {
    // GitHub leaves these keys out of some payloads and sends null in
    // others. A caller looking for unclaimed work compares lengths, so both
    // have to arrive as an empty array — null has no length, and the
    // comparison would throw or read as a claim.
    useFixture({
      getPull: pullClaiming({ requested_reviewers: null }),
      listPullFiles: pagedFiles([fileEntry("source/rest/handler.go")]),
    });

    expect(asReviewerClaim(await inspectRaw({}))).toEqual({
      requested_reviewers: [],
      requested_teams: [],
      assignees: [],
    });
  });
});

describe("github.inspect_pull_request path scoping", () => {
  const FILES = [
    fileEntry("source/rest/handler.go", patchOf(2, "a")),
    fileEntry("source/rest/router.go", patchOf(2, "b")),
    fileEntry("source/grpc/server.go", patchOf(2, "c")),
    fileEntry("docs/readme.md", patchOf(2, "d")),
  ];

  it("counts every file when no prefixes are given", async () => {
    useFixture({ getPull: pullWith(4), listPullFiles: pagedFiles(FILES) });

    const data = await inspect({});

    expect(data.matched_file_count).toBe(4);
    expect(data.files_complete).toBe(true);
  });

  it("filters files and reports the match count as a scalar", async () => {
    useFixture({ getPull: pullWith(4), listPullFiles: pagedFiles(FILES) });

    const data = await inspect({ pathPrefixes: ["source/rest"] });

    expect(data.files.map((f) => f.filename)).toEqual([
      "source/rest/handler.go",
      "source/rest/router.go",
    ]);
    expect(data.matched_file_count).toBe(2);
  });

  it("reports zero matches without failing, so a gate can skip the run", async () => {
    useFixture({ getPull: pullWith(4), listPullFiles: pagedFiles(FILES) });

    const data = await inspect({ pathPrefixes: ["source/graphql"] });

    expect(data.files).toEqual([]);
    expect(data.matched_file_count).toBe(0);
  });

  it("matches any of several prefixes", async () => {
    useFixture({ getPull: pullWith(4), listPullFiles: pagedFiles(FILES) });

    const data = await inspect({ pathPrefixes: ["source/grpc", "docs/"] });

    expect(data.matched_file_count).toBe(2);
  });

  it("spends the patch budget only on files that survive the filter", async () => {
    useFixture({ getPull: pullWith(4), listPullFiles: pagedFiles(FILES) });

    const data = await inspect({ pathPrefixes: ["docs/"], includePatch: true });

    expect(data.files).toHaveLength(1);
    expect(data.files[0].patch).toBe(patchOf(2, "d"));
    expect(data.patch_summary?.included_bytes).toBe(100);
  });
});

describe("github.inspect_pull_request file pagination", () => {
  const MANY = Array.from({ length: 150 }, (_, i) =>
    fileEntry(i < 120 ? `source/rest/f${i}.go` : `docs/f${i}.md`),
  );

  it("pages past GitHub's 100-per-page ceiling so the count is not short", async () => {
    const server = useFixture({ getPull: pullWith(150), listPullFiles: pagedFiles(MANY) });

    const data = await inspect({ filesLimit: 200, pathPrefixes: ["docs/"] });

    const fileCalls = server.calls.filter((c) => c.path.endsWith("/files"));
    expect(fileCalls.map((c) => c.query.page)).toEqual(["1", "2"]);
    expect(fileCalls.every((c) => Number(c.query.per_page) <= 100)).toBe(true);
    expect(data.matched_file_count).toBe(30);
    expect(data.files_complete).toBe(true);
  });

  it("flags an incomplete file list rather than reporting a short count as final", async () => {
    useFixture({ getPull: pullWith(150), listPullFiles: pagedFiles(MANY) });

    const data = await inspect({ filesLimit: 100 });

    expect(data.matched_file_count).toBe(100);
    expect(data.files_complete).toBe(false);
  });
});

// ─── create_review ──────────────────────────────────────────────────────────
//
// Each test here that posts a review takes about 3 seconds. This is not a hang.
// `POST /pulls/{n}/reviews` is on Octokit's "notifications" throttle group,
// which holds successive calls 3000 ms apart to stay under GitHub's secondary
// rate limit. The Bottleneck group is module state, so the pacing carries
// across Octokit instances and across tests. Turning it off would stop testing
// the client the action really uses.

const MARKER = "<!-- valet-review:default -->";

async function createReview(args: Record<string, unknown>) {
  return findAction("github.create_review").execute(
    { owner: "acme", repo: "widgets", pullNumber: 7, ...args },
    fakeActionContext("test-token"),
  );
}

function reviewWrites(server: GithubFixture): GithubFixtureCall[] {
  return server.calls.filter((c) => c.method === "POST" || c.method === "PUT");
}

describe("github.search_issues", () => {
  async function search(args: Record<string, unknown>) {
    return findAction("github.search_issues").execute(
      { q: "repo:acme/widgets is:open is:pr review:none", ...args },
      fakeActionContext("test-token"),
    );
  }

  it("sends the order it is given, because the response cannot show it", async () => {
    // The search returns ONE page and cannot ask for a second. A caller
    // that sweeps for neglected work therefore depends on oldest-first:
    // whatever the page size cuts must be the recent end of the list. The
    // response body looks the same either way, so the only place that
    // contract can be checked is the query this action sends.
    const server = useFixture();

    const result = await search({ sort: "created", order: "asc", limit: 50 });

    expect(result.success).toBe(true);
    expect(server.calls[0]?.query).toMatchObject({
      q: "repo:acme/widgets is:open is:pr review:none",
      sort: "created",
      order: "asc",
      per_page: "50",
    });
  });

  it("sends no order when the caller gives none, leaving GitHub's own default", async () => {
    const server = useFixture();

    await search({});

    expect(server.calls[0]?.query.sort).toBeUndefined();
    expect(server.calls[0]?.query.order).toBeUndefined();
  });

  it("maps the created time and the URL a caller sorts and reports on", async () => {
    useFixture({
      searchIssues: () => ({
        body: {
          total_count: 1,
          items: [
            {
              number: 7,
              title: "fixture pull request",
              state: "open",
              user: { login: "fixture-user" },
              html_url: "https://github.com/acme/widgets/pull/7",
              pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/7" },
              labels: [{ name: "area/api" }],
              created_at: "2026-08-01T00:00:00Z",
              updated_at: "2026-08-10T00:00:00Z",
            },
          ],
        },
      }),
    });

    const result = await search({ sort: "created", order: "asc" });

    expect(result.success).toBe(true);
    if (!result.success) return;
    const items = isRecord(result.data) ? result.data.items : undefined;
    expect(Array.isArray(items) ? items[0] : undefined).toMatchObject({
      number: 7,
      url: "https://github.com/acme/widgets/pull/7",
      created_at: "2026-08-01T00:00:00Z",
      is_pr: true,
    });
  });
});

describe("github.read_repo_file", () => {
  async function read(path: string) {
    return findAction("github.read_repo_file").execute(
      { owner: "acme", repo: "handbook", path },
      fakeActionContext("test-token"),
    );
  }

  it("decodes the base64 GitHub sends", async () => {
    const text = "path_prefix,area,github_handle,slack_user_id\npackages/api/,api,an-account,U0FIXTURE1";
    useFixture({
      readFile: (_owner, _repo, path) => ({
        body: { type: "file", encoding: "base64", path, size: text.length, content: Buffer.from(text).toString("base64") },
      }),
    });

    const result = await read(".github/reviewer-routing.csv");

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(isRecord(result.data) ? result.data.content : undefined).toBe(text);
  });

  it("names both corrections when GitHub answers 404", async () => {
    // GitHub sends 404 for a path that is not there AND for a repository the
    // token cannot see. A caller reading a configuration file out of another
    // repository meets the second case, and a bare "404 Not Found" sends
    // them to check the path they already checked.
    useFixture({ readFile: () => ({ status: 404, body: { message: "Not Found" } }) });

    const result = await read(".github/reviewer-routing.csv");

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('no file at ".github/reviewer-routing.csv" in acme/handbook');
    expect(result.error).toContain("Correct the path");
    expect(result.error).toContain("read access to that repository");
  });
});

describe("github.create_review", () => {
  it("posts the review with the event it is given", async () => {
    const server = useFixture({
      createReview: () => ({
        body: { id: 900, state: "COMMENTED", html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-900" },
      }),
    });

    const result = await createReview({ body: "Looks reasonable.", event: "COMMENT" });

    expect(result.success).toBe(true);
    const writes = reviewWrites(server);
    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe("POST");
    expect(writes[0].path).toBe("/repos/acme/widgets/pulls/7/reviews");
    expect(isRecord(writes[0].body) && writes[0].body.event).toBe("COMMENT");
    expect(isRecord(writes[0].body) && String(writes[0].body.body)).toContain("Looks reasonable.");
  });

  it("leaves the review pending when no event is given", async () => {
    const server = useFixture({
      createReview: () => ({ body: { id: 901, state: "PENDING", html_url: "https://github.com/acme/widgets/pull/7" } }),
    });

    const result = await createReview({ body: "Draft notes." });

    expect(result.success).toBe(true);
    const write = reviewWrites(server)[0];
    if (!isRecord(write.body)) throw new Error("no request body recorded");
    // Omitted, not defaulted: GitHub keeps a review with no event PENDING,
    // which is how a reviewer stages comments before submitting them.
    expect("event" in write.body).toBe(false);
    if (!isRecord(result.data)) throw new Error("no data");
    expect(result.data.state).toBe("PENDING");
  });

  it("pins the review to commitId so a later push cannot re-anchor it", async () => {
    const server = useFixture();

    await createReview({ body: "Reviewed at the fetched head.", event: "COMMENT", commitId: "abc123def" });

    const write = reviewWrites(server)[0];
    expect(isRecord(write.body) && write.body.commit_id).toBe("abc123def");
  });

  it("forwards a legacy position anchor without a line anchor", async () => {
    const server = useFixture();

    await createReview({
      body: "One finding.",
      event: "COMMENT",
      comments: [{ path: "source/rest/handler.go", position: 5, body: "Leaked handle." }],
    });

    const write = reviewWrites(server)[0];
    if (!isRecord(write.body)) throw new Error("no request body recorded");
    expect(write.body.comments).toEqual([
      { path: "source/rest/handler.go", position: 5, body: "Leaked handle." },
    ]);
  });

  it("requires a body for COMMENT and for REQUEST_CHANGES, and names the fix", async () => {
    const server = useFixture();

    for (const event of ["COMMENT", "REQUEST_CHANGES"]) {
      const result = await createReview({ event });
      expect(result.success).toBe(false);
      expect(result.error).toContain("body");
      expect(result.error).toContain(event);
    }
    expect(reviewWrites(server)).toHaveLength(0);
  });

  it("rejects a comment that mixes position with a line anchor", async () => {
    const server = useFixture();

    const result = await createReview({
      body: "Findings.",
      event: "COMMENT",
      comments: [{ path: "a.go", position: 5, line: 12, body: "nit" }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("position");
    expect(result.error).toContain("line");
    expect(reviewWrites(server)).toHaveLength(0);
  });

  it("rejects a range comment with no end line", async () => {
    const server = useFixture();

    const result = await createReview({
      body: "Findings.",
      event: "COMMENT",
      comments: [{ path: "a.go", startLine: 10, body: "nit" }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("startLine");
    expect(reviewWrites(server)).toHaveLength(0);
  });

  it("rejects a comment with no anchor at all", async () => {
    const server = useFixture();

    const result = await createReview({
      body: "Findings.",
      event: "COMMENT",
      comments: [{ path: "a.go", body: "nit" }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("line");
    expect(reviewWrites(server)).toHaveLength(0);
  });

  it("rejects updateExisting with no body, since there is nothing to replace", async () => {
    const server = useFixture();

    const result = await createReview({ updateExisting: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain("body");
    expect(reviewWrites(server)).toHaveLength(0);
  });

  it("passes REQUEST_CHANGES through when asked", async () => {
    const server = useFixture();

    await createReview({ body: "Please fix the leak.", event: "REQUEST_CHANGES" });

    const write = reviewWrites(server)[0];
    expect(isRecord(write.body) && write.body.event).toBe("REQUEST_CHANGES");
  });

  it("sends inline comments in GitHub's snake_case shape", async () => {
    const server = useFixture();

    await createReview({
      body: "Two findings.",
      comments: [
        { path: "source/rest/handler.go", line: 42, body: "Close the response body." },
        { path: "source/rest/router.go", line: 18, side: "LEFT", startLine: 15, startSide: "LEFT", body: "Dead route." },
      ],
    });

    const write = reviewWrites(server)[0];
    if (!isRecord(write.body)) throw new Error("no request body recorded");
    expect(write.body.comments).toEqual([
      { path: "source/rest/handler.go", line: 42, body: "Close the response body." },
      { path: "source/rest/router.go", line: 18, side: "LEFT", start_line: 15, start_side: "LEFT", body: "Dead route." },
    ]);
  });

  it("marks its own reviews so a later run can find them", async () => {
    const server = useFixture();

    await createReview({ body: "First pass." });

    const write = reviewWrites(server)[0];
    expect(isRecord(write.body) && String(write.body.body)).toContain(MARKER);
  });

  it("updateExisting posts a new review when the pull request has none of ours", async () => {
    const server = useFixture({
      listReviews: () => ({ body: [{ id: 1, state: "COMMENTED", body: "a human review", user: { login: "human-reviewer" } }] }),
    });

    const result = await createReview({ body: "First automated pass.", updateExisting: true });

    expect(result.success).toBe(true);
    const writes = reviewWrites(server);
    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe("POST");
  });

  it("updateExisting finds our review past the first page of 100", async () => {
    // GitHub returns reviews oldest-first. A bot that re-reviews on every
    // push is exactly what pushes its own review off page 1, so a
    // single-page read would stop updating and start stacking duplicates.
    const older = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      state: "COMMENTED",
      body: "a human review",
      user: { login: "human-reviewer" },
    }));
    const ours = { id: 999, state: "COMMENTED", body: `Stale findings.\n\n${MARKER}`, user: { login: "valet[bot]" } };
    const all = [...older, ours];
    const server = useFixture({
      listReviews: (_ref, query) => {
        const perPage = Number(query.per_page ?? "30");
        const page = Number(query.page ?? "1");
        const start = (page - 1) * perPage;
        return { body: all.slice(start, start + perPage) };
      },
    });

    const result = await createReview({ body: "Fresh findings.", updateExisting: true });

    expect(result.success).toBe(true);
    const writes = reviewWrites(server);
    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe("PUT");
    expect(writes[0].path).toBe("/repos/acme/widgets/pulls/7/reviews/999");
  });

  it("updateExisting replaces the body of our previous review in place", async () => {
    const server = useFixture({
      listReviews: () => ({
        body: [
          { id: 1, state: "COMMENTED", body: "a human review", user: { login: "human-reviewer" } },
          { id: 42, state: "COMMENTED", body: `Stale findings.\n\n${MARKER}`, user: { login: "valet[bot]" } },
        ],
      }),
    });

    const result = await createReview({ body: "Fresh findings.", updateExisting: true });

    expect(result.success).toBe(true);
    const writes = reviewWrites(server);
    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe("PUT");
    expect(writes[0].path).toBe("/repos/acme/widgets/pulls/7/reviews/42");
    expect(isRecord(writes[0].body) && String(writes[0].body.body)).toContain("Fresh findings.");
    expect(isRecord(writes[0].body) && String(writes[0].body.body)).toContain(MARKER);
  });

  it("keeps review streams apart by updateKey", async () => {
    const server = useFixture({
      listReviews: () => ({
        body: [{ id: 42, state: "COMMENTED", body: `Style pass.\n\n<!-- valet-review:style -->`, user: { login: "valet[bot]" } }],
      }),
    });

    await createReview({ body: "Security pass.", updateExisting: true, updateKey: "security" });

    expect(reviewWrites(server)[0].method).toBe("POST");
  });

  it("refuses to combine updateExisting with inline comments, and names the fix", async () => {
    const server = useFixture();

    const result = await createReview({
      body: "Findings.",
      updateExisting: true,
      comments: [{ path: "a.go", line: 1, body: "nit" }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("updateExisting");
    expect(result.error).toContain("comments");
    expect(reviewWrites(server)).toHaveLength(0);
  });

  it("explains a 422 on inline comments instead of relaying GitHub's wording", async () => {
    useFixture({
      createReview: () => ({
        status: 422,
        body: { message: "Validation Failed", errors: [{ resource: "PullRequestReviewComment", field: "line" }] },
      }),
    });

    const result = await createReview({
      body: "Findings.",
      comments: [{ path: "source/rest/handler.go", line: 9999, body: "nit" }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("inspect_pull_request");
    expect(result.error).toContain("includePatch");
  });

  it("reports the review id, url, and whether it updated in place", async () => {
    useFixture({
      createReview: () => ({
        body: { id: 900, state: "COMMENTED", html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-900" },
      }),
    });

    const result = await createReview({ body: "Looks reasonable.", comments: [{ path: "a.go", line: 1, body: "nit" }] });

    expect(result.success).toBe(true);
    if (!isRecord(result.data)) throw new Error("no data");
    expect(result.data.review_id).toBe(900);
    expect(result.data.url).toBe("https://github.com/acme/widgets/pull/7#pullrequestreview-900");
    expect(result.data.updated).toBe(false);
    expect(result.data.inline_comments).toBe(1);
  });
});

// ─── update_pull_request ────────────────────────────────────────────────────

describe("github.update_pull_request", () => {
  async function update(args: Record<string, unknown>) {
    return findAction("github.update_pull_request").execute(
      { owner: "acme", repo: "widgets", pullNumber: 7, ...args },
      fakeActionContext("test-token"),
    );
  }

  it("sends title, body, and state through the pulls endpoint", async () => {
    const server = useFixture();

    const result = await update({ title: "New title", body: "New body.", state: "closed" });

    expect(result.success).toBe(true);
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "PATCH /repos/acme/widgets/pulls/7",
    ]);
    expect(server.calls[0].body).toEqual({ title: "New title", body: "New body.", state: "closed" });
  });

  it("routes assignees through the issues endpoint, which the pulls endpoint rejects", async () => {
    const server = useFixture();

    const result = await update({ title: "New title", assignees: ["first-account"] });

    expect(result.success).toBe(true);
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "PATCH /repos/acme/widgets/pulls/7",
      "PATCH /repos/acme/widgets/issues/7",
    ]);
    expect(server.calls[0].body).toEqual({ title: "New title" });
    expect(server.calls[1].body).toEqual({ assignees: ["first-account"] });
  });

  it("skips the pulls call when only assignees is given", async () => {
    const server = useFixture();

    const result = await update({ assignees: ["first-account", "second-account"] });

    expect(result.success).toBe(true);
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "PATCH /repos/acme/widgets/issues/7",
    ]);
    expect(server.calls[0].body).toEqual({ assignees: ["first-account", "second-account"] });
    if (!isRecord(result.data)) throw new Error("no data");
    // The response fields come from the issues PATCH when it is the only call.
    expect(result.data.number).toBe(7);
    expect(result.data.url).toBe("https://github.com/acme/widgets/pull/7");
  });

  it("sends an empty assignees list, which unassigns everybody", async () => {
    const server = useFixture();

    const result = await update({ assignees: [] });

    expect(result.success).toBe(true);
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "PATCH /repos/acme/widgets/issues/7",
    ]);
    expect(server.calls[0].body).toEqual({ assignees: [] });
  });
});
