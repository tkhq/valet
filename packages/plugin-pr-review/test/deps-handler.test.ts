/**
 * The review-dependencies handler with a fake GitHub, OSV and registry:
 * what it posts when a pull request adds a package with an advisory, how a
 * later push keeps or resolves findings in the same summary, and that a
 * pull request with no dependency change costs nothing.
 */
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import type { PluginChild, PluginChildRequest, PluginEvent, PluginEventContext, PluginStoreDoc, PluginThreadRef, PluginThreads, ScopedPluginStore, SubmissionResult } from "@valet/engine";
import {
  acceptsDependencyEvent,
  createDependencyReviewHandler,
  DEPENDENCY_COLLECTION,
  DependencySettingsSchema,
  parseFindings,
  POINTERS_COLLECTION,
  REACHABILITY_ROLE,
  type DependencyPullState,
  type ReachabilityVerdict,
} from "../src/index.js";

const OWNER = "acme";
const REPO = "site";
const SLUG = "acme/site#7";
const BASE = "b".repeat(40);
const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const OSV = "https://api.osv.dev/v1";
const URLS = { npm: "https://npm.test", crates: "https://crates.test", pypi: "https://pypi.test", goproxy: "https://goproxy.test" };

const manifest = (deps: Record<string, string>): string => JSON.stringify({ name: "site", dependencies: deps }, null, 2);
const lockfile = (deps: Record<string, string>): string =>
  JSON.stringify(
    {
      name: "site",
      lockfileVersion: 3,
      packages: { "": { dependencies: deps }, ...Object.fromEntries(Object.entries(deps).map(([n, v]) => [`node_modules/${n}`, { version: v, license: "MIT" }])) },
    },
    null,
    2,
  );

/** A patch that adds every line of `text`: each line is commentable. */
const addedPatch = (text: string): string => `@@ -0,0 +1,${text.split("\n").length} @@\n${text.split("\n").map((l) => `+${l}`).join("\n")}`;

interface Comment {
  id: number;
  path: string;
  line: number;
  body: string;
  pull_request_review_id: number;
}

/** An in-memory GitHub for pull request 7, plus OSV and npm registry answers. */
class Fake {
  head = H1;
  draft = false;
  forkHead = false;
  /** Head file text by path; base text by path. */
  headFiles: Record<string, string> = {};
  baseFiles: Record<string, string> = {};
  /** The PR's changed files. */
  changed: { filename: string; status: string; patch?: string }[] = [];
  reviews = new Map<number, { id: number; body: string }>();
  comments: Comment[] = [];
  resolved = new Map<number, string>();
  writes: string[] = [];
  reads: string[] = [];
  osvCalls = 0;
  /** OSV vulns by `name@version`. */
  vulns: Record<string, { id: string; summary: string; severity: string; fixed: string }[]> = {};
  osvDown = false;
  /** npm version documents by `name@version`. */
  npmVersions: Record<string, Record<string, unknown>> = {};
  npmCreated: Record<string, string> = {};
  /** Files compare(<earlier head>, head) lists: what a later push changed. */
  pushFiles: string[] = ["package.json"];
  private nextId = 100;

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const ok = (data: unknown): Response => new Response(typeof data === "string" ? data : JSON.stringify(data), { status: 200 });
    const missing = (): Response => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });

    if (url.href.startsWith(OSV)) {
      this.osvCalls++;
      if (this.osvDown) return new Response("unavailable", { status: 503 });
      if (url.pathname.endsWith("/querybatch")) {
        const queries = body.queries as { package: { name: string }; version: string }[];
        return ok({ results: queries.map((q) => ({ vulns: (this.vulns[`${q.package.name}@${q.version}`] ?? []).map((v) => ({ id: v.id })) })) });
      }
      const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      for (const [key, list] of Object.entries(this.vulns)) {
        const v = list.find((x) => x.id === id);
        if (v) {
          const name = key.slice(0, key.lastIndexOf("@"));
          return ok({ id, summary: v.summary, details: `${v.summary}. Fixed in ${v.fixed}.`, database_specific: { severity: v.severity }, affected: [{ package: { ecosystem: "npm", name }, ranges: [{ events: [{ introduced: "0" }, { fixed: v.fixed }] }] }] });
        }
      }
      return missing();
    }
    if (url.origin === URLS.npm) {
      const parts = decodeURIComponent(url.pathname.slice(1)).split("/");
      const name = parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
      const version = parts[0].startsWith("@") ? parts[2] : parts[1];
      if (version === undefined) return this.npmCreated[name] ? ok({ time: { created: this.npmCreated[name] } }) : missing();
      const doc = this.npmVersions[`${name}@${version}`];
      return doc ? ok(doc) : ok({ license: "MIT", maintainers: [{ name: "owner" }], _npmUser: { name: "owner" }, scripts: {} });
    }

    const path = url.pathname.replace(`/repos/${OWNER}/${REPO}`, "");
    if (method !== "GET" && path !== "/graphql") this.writes.push(`${method} ${path}`);
    else if (method === "GET") this.reads.push(path);
    if (method === "POST" && path === "/graphql") {
      const query = String(body.query);
      if (query.includes("reviewThreads")) {
        const nodes = this.comments.map((c) => ({
          id: `T_${c.id}`,
          isResolved: this.resolved.has(c.id),
          resolvedBy: this.resolved.has(c.id) ? { login: this.resolved.get(c.id) } : null,
          comments: { nodes: [{ databaseId: c.id, author: { login: "valet[bot]" } }] },
        }));
        return ok({ data: { repository: { pullRequest: { reviewThreads: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } } });
      }
      const id = Number(String((body.variables as { id: string }).id).replace("T_", ""));
      this.resolved.set(id, "valet[bot]");
      this.writes.push(`resolve ${id}`);
      return ok({ data: {} });
    }
    if (method === "GET" && path === "/collaborators/author/permission") return missing();
    if (method === "GET" && path === "/pulls/7") {
      return ok({
        number: 7, state: "open", draft: this.draft, title: "Add lodash", body: "", user: { login: "author" },
        head: { sha: this.head, ref: "feature", repo: { full_name: this.forkHead ? "someone/site" : "acme/site" } },
        base: { sha: BASE, ref: "main", repo: { full_name: "acme/site" } },
      });
    }
    if (method === "GET" && path === "/pulls/7/files") return ok(url.searchParams.get("page") === "1" ? this.changed.map((f) => ({ additions: 1, deletions: 0, ...f })) : []);
    if (method === "GET" && path.startsWith("/compare/")) {
      const from = path.slice("/compare/".length).split("...")[0];
      return ok({ status: "ahead", merge_base_commit: { sha: BASE }, files: from === BASE ? [] : this.pushFiles.map((filename) => ({ filename })) });
    }
    if (method === "GET" && path.startsWith("/contents/")) {
      const file = decodeURIComponent(path.slice("/contents/".length));
      const text = url.searchParams.get("ref") === BASE ? this.baseFiles[file] : this.headFiles[file];
      return text === undefined ? missing() : ok(text);
    }
    if (method === "GET" && path === "/pulls/7/comments") return ok(url.searchParams.get("page") === "1" ? this.comments : []);
    const reviewMatch = /^\/pulls\/7\/reviews\/(\d+)$/.exec(path);
    if (reviewMatch) {
      const review = this.reviews.get(Number(reviewMatch[1]));
      if (!review) return missing();
      if (method === "PUT") review.body = String(body.body);
      return ok(review);
    }
    if (method === "POST" && path === "/pulls/7/reviews") {
      const id = this.nextId++;
      this.reviews.set(id, { id, body: String(body.body ?? "") });
      for (const c of (body.comments as { path: string; line: number; body: string }[]) ?? []) this.comments.push({ id: this.nextId++, path: c.path, line: c.line, body: c.body, pull_request_review_id: id });
      return ok({ id, body: body.body });
    }
    const commentMatch = /^\/pulls\/comments\/(\d+)$/.exec(path);
    if (method === "PATCH" && commentMatch) {
      const c = this.comments.find((x) => x.id === Number(commentMatch[1]));
      if (c) c.body = String(body.body);
      return ok({});
    }
    return new Response(JSON.stringify({ message: `unexpected ${method} ${path}` }), { status: 500 });
  };

  /** Set the PR to change package.json and package-lock.json from `from` to `to` dependencies. */
  dependencies(from: Record<string, string>, to: Record<string, string>): void {
    this.baseFiles = { "package.json": manifest(from), "package-lock.json": lockfile(from) };
    this.headFiles = { "package.json": manifest(to), "package-lock.json": lockfile(to), "src/index.ts": "import _ from 'lodash';\n" };
    this.changed = [
      { filename: "package.json", status: "modified", patch: addedPatch(manifest(to)) },
      { filename: "package-lock.json", status: "modified", patch: addedPatch(lockfile(to)) },
    ];
  }

  summary(): string {
    return [...this.reviews.values()].find((r) => r.body.includes("valet-dependency-review:summary"))?.body ?? "";
  }
}

class FakeStore implements ScopedPluginStore {
  docs = new Map<string, PluginStoreDoc<unknown>>();
  async get<T>(collection: string, key: string): Promise<PluginStoreDoc<T> | null> {
    return (this.docs.get(`${collection}/${key}`) as PluginStoreDoc<T> | undefined) ?? null; // test store: each key holds what the handler put
  }
  async put<T>(collection: string, key: string, doc: T, opts?: { ifRevision?: number }): Promise<PluginStoreDoc<T>> {
    const current = this.docs.get(`${collection}/${key}`);
    if (opts?.ifRevision !== undefined && current?.revision !== opts.ifRevision) throw new Error("revision moved");
    const next: PluginStoreDoc<T> = { key, doc, revision: (current?.revision ?? 0) + 1, createdAt: 0, updatedAt: 0 };
    this.docs.set(`${collection}/${key}`, next);
    return next;
  }
  async list<T>(): Promise<{ items: PluginStoreDoc<T>[]; nextCursor: string | null }> {
    return { items: [], nextCursor: null };
  }
  async delete(collection: string, key: string): Promise<boolean> {
    return this.docs.delete(`${collection}/${key}`);
  }
  state(): DependencyPullState | undefined {
    return this.docs.get(`${DEPENDENCY_COLLECTION}/${SLUG}`)?.doc as DependencyPullState | undefined;
  }
}

class FakeThreads implements PluginThreads {
  spawned: PluginChildRequest[] = [];
  constructor(public answer: (req: PluginChildRequest) => SubmissionResult["output"] | undefined) {}
  async ensure(key: string): Promise<PluginThreadRef> {
    return { sessionId: "s1", threadId: "t1", key: `plugin:pr-review:${key}` };
  }
  async post(): Promise<never> {
    throw new Error("not used");
  }
  async record(): Promise<void> {}
  async awaitReply(): Promise<never> {
    throw new Error("not used");
  }
  async spawnChild(_t: PluginThreadRef, req: PluginChildRequest, opts: { dispatchId: string }): Promise<PluginChild> {
    this.spawned.push(req);
    return { childSessionId: opts.dispatchId, queueItemId: `q-${opts.dispatchId}` };
  }
  async awaitChild(child: PluginChild): Promise<SubmissionResult> {
    const req = this.spawned[this.spawned.length - 1];
    const output = this.answer(req);
    return output === undefined ? { queueItemId: child.queueItemId, outcome: "failed", error: "no answer" } : { queueItemId: child.queueItemId, outcome: "completed", output };
  }
  async stopChild(): Promise<{ stopped: number }> {
    return { stopped: 0 };
  }
}

const reachable = (r: ReachabilityVerdict["reachable"]) => (req: PluginChildRequest) => {
  const refs = [...req.prompt.matchAll(/^### (a\d+):/gm)].map((m) => m[1]);
  return { verdicts: refs.map((ref) => ({ ref, reachable: r, evidence: r === "yes" ? "src/index.ts:1" : "rg lodash found no import", reason: r === "yes" ? "index imports lodash and calls template." : "lodash is never imported." })) };
};

function event(id: string, key = "github.pull_request.synchronize", draft = false): PluginEvent {
  return { id, key, dedupeKey: `d-${id}`, occurredAt: new Date().toISOString(), refs: { repo: "acme/site" }, summary: "PR #7", payload: { action: "synchronize", pull_request: { number: 7, draft } } };
}

function context(threads: PluginThreads, store: ScopedPluginStore, config: Record<string, unknown> = {}): PluginEventContext {
  return {
    orgId: "org-1",
    owner: { type: "user", id: "user-1" },
    actorUserId: "user-1",
    threads,
    config: Value.Default(DependencySettingsSchema, structuredClone(config)) as Record<string, unknown>,
    store,
    memory: { search: async () => [], read: async () => null, list: async () => [], write: async () => {} },
    appToken: async () => "ghs_test",
    appLogin: async () => "valet[bot]",
    signal: new AbortController().signal,
  };
}

const LODASH_ADVISORY = { id: "GHSA-35jh-r3h4-6jhm", summary: "Command Injection in lodash", severity: "HIGH", fixed: "4.17.21" };

function setup(answer = reachable("yes"), config: Record<string, unknown> = {}) {
  const gh = new Fake();
  const store = new FakeStore();
  const threads = new FakeThreads(answer);
  const handler = createDependencyReviewHandler({ fetch: gh.fetch, registryUrls: URLS, now: () => new Date("2026-11-20T00:00:00Z") });
  const run = (id: string, key?: string) => handler.handle(event(id, key), context(threads, store, config));
  return { gh, store, threads, run };
}

describe("review-dependencies handler", () => {
  it("costs nothing and posts nothing when the pull request changes no dependency file", async () => {
    const { gh, store, threads, run } = setup();
    gh.changed = [{ filename: "src/index.ts", status: "modified", patch: "@@ -1 +1 @@\n+x" }];
    await run("e1");
    expect(gh.writes).toEqual([]);
    expect(gh.reads).toEqual(["/pulls/7", "/pulls/7/files"]);
    expect(gh.osvCalls).toBe(0);
    expect(threads.spawned).toEqual([]);
    expect(store.state()).toBeUndefined();
  });

  it("posts nothing when a manifest edit changes no package", async () => {
    const { gh, run } = setup();
    gh.dependencies({ react: "18.2.0" }, { react: "18.2.0" });
    gh.changed = gh.changed.slice(0, 1);
    await run("e1");
    expect(gh.writes).toEqual([]);
    expect(gh.osvCalls).toBe(0);
  });

  it("flags an added package with an advisory inline on its manifest line, with reachability, in its own summary", async () => {
    const { gh, store, threads, run } = setup(reachable("yes"));
    gh.dependencies({ react: "18.2.0" }, { react: "18.2.0", lodash: "4.17.20" });
    gh.vulns["lodash@4.17.20"] = [LODASH_ADVISORY];
    await run("e1");

    // One reachability child, read-only, at the head, with the advisory in its prompt.
    expect(threads.spawned).toHaveLength(1);
    expect(threads.spawned[0]).toMatchObject({ role: REACHABILITY_ROLE, repo: "acme/site", ref: H1, gitAccess: "read" });
    expect(threads.spawned[0].prompt).toContain("### a1: GHSA-35jh-r3h4-6jhm in npm package lodash 4.17.20");

    // One review: the summary body plus the inline comment on package.json's lodash line.
    expect(gh.writes).toEqual(["POST /pulls/7/reviews"]);
    expect(gh.comments).toHaveLength(1);
    const [comment] = gh.comments;
    expect(comment.path).toBe("package.json");
    expect(manifest({ react: "18.2.0", lodash: "4.17.20" }).split("\n")[comment.line - 1]).toContain('"lodash"');
    expect(comment.body).toContain("High · dependency advisory");
    expect(comment.body).toContain("<!-- valet-dependency-review:finding d1 high advisory -->");
    expect(comment.body).toContain("**Reachable.** index imports lodash and calls template. src/index.ts:1");
    expect(comment.body).toContain("Upgrade to 4.17.21 or later.");

    const summary = gh.summary();
    expect(summary).toContain(`<!-- valet-dependency-review:summary ${H1} -->`);
    expect(summary).toContain("## Valet dependency review");
    expect(summary).toContain("1 added");
    expect(summary).toContain("### Open findings (1)");
    expect(summary).toContain("| `lodash` (npm) | added 4.17.20 | direct |");
    // No merge confidence: that belongs to the general review.
    expect(summary).not.toContain("Merge confidence");

    // Its own state; the general review's collection and markers are untouched.
    expect(store.state()).toMatchObject({ lastReviewedHead: H1, nextId: 2, findings: [{ id: "d1", key: "npm:lodash@4.17.20:advisory:GHSA-35jh-r3h4-6jhm", status: "open", commentId: comment.id, severity: "high" }] });
    expect(store.docs.has(`${POINTERS_COLLECTION}/${SLUG}`)).toBe(false);
    expect(parseFindings(comment.body).size).toBe(0);
    expect(parseFindings(summary).size).toBe(0);
  });

  it("lowers an advisory the code does not reach by one level", async () => {
    const { gh, run } = setup(reachable("no"));
    gh.dependencies({}, { lodash: "4.17.20" });
    gh.vulns["lodash@4.17.20"] = [LODASH_ADVISORY];
    await run("e1");
    expect(gh.comments[0].body).toContain("Medium · dependency advisory");
    expect(gh.comments[0].body).toContain("**Not reached by this code**");
  });

  it("still posts the advisory when the reachability child gives no answer, and says so", async () => {
    const { gh, run } = setup(() => undefined);
    gh.dependencies({}, { lodash: "4.17.20" });
    gh.vulns["lodash@4.17.20"] = [LODASH_ADVISORY];
    await run("e1");
    expect(gh.comments[0].body).toContain("High · dependency advisory");
    expect(gh.summary()).toContain("Reachability was not checked: the reachability child ended without an answer.");
  });

  it("starts no child for a pull request from a fork whose author has no write access", async () => {
    const { gh, threads, run } = setup();
    gh.forkHead = true;
    gh.dependencies({}, { lodash: "4.17.20" });
    gh.vulns["lodash@4.17.20"] = [LODASH_ADVISORY];
    await run("e1");
    expect(threads.spawned).toEqual([]);
    expect(gh.comments).toHaveLength(1);
    expect(gh.summary()).toContain("Reachability was not checked: the pull request comes from a fork");
  });

  it("on a later push, keeps an open finding, and resolves one whose version the pull request no longer adds, in the same summary", async () => {
    const { gh, store, threads, run } = setup();
    gh.dependencies({}, { lodash: "4.17.20" });
    gh.vulns["lodash@4.17.20"] = [LODASH_ADVISORY];
    await run("e1");
    const summaryId = store.state()?.reviewId;
    const commentId = gh.comments[0].id;

    // Same head again: skipped.
    gh.writes = [];
    await run("e2");
    expect(gh.writes).toEqual([]);

    // A new push that keeps the version: no new comment, the summary is edited in place.
    gh.head = H2;
    await run("e3");
    expect(gh.writes).toEqual([`PUT /pulls/7/reviews/${summaryId}`]);
    expect(gh.comments).toHaveLength(1);
    expect(threads.spawned).toHaveLength(1);

    // A push that upgrades to the fixed version resolves the finding.
    gh.head = "3".repeat(40);
    gh.dependencies({}, { lodash: "4.17.21" });
    gh.writes = [];
    await run("e4");
    expect(gh.writes).toEqual([`PUT /pulls/7/reviews/${summaryId}`, `PATCH /pulls/comments/${commentId}`, `resolve ${commentId}`]);
    expect(gh.comments[0].body).toMatch(/^\*\*Resolved in `3333333`\.\*\* The pull request no longer adds this package version\./);
    expect(gh.summary()).toContain("### Resolved (1)");
    expect(gh.summary()).toContain("No open findings.");
    expect(store.state()?.findings[0]).toMatchObject({ status: "resolved", resolvedIn: "3".repeat(40) });
  });

  it("judges an open advisory again when a push changes code, and rewrites its comment when the verdict changes", async () => {
    const { gh, store, threads, run } = setup(reachable("no"));
    gh.dependencies({}, { lodash: "4.17.20" });
    gh.vulns["lodash@4.17.20"] = [LODASH_ADVISORY];
    await run("e1");
    expect(gh.comments[0].body).toContain("Medium · dependency advisory");
    const commentId = gh.comments[0].id;

    // A push that changes only dependency files does not judge it again.
    gh.head = H2;
    gh.pushFiles = ["package.json"];
    await run("e2");
    expect(threads.spawned).toHaveLength(1);

    // A push that adds a call to the affected function does.
    threads.answer = reachable("yes");
    gh.head = "3".repeat(40);
    gh.pushFiles = ["src/index.ts"];
    gh.writes = [];
    await run("e3");
    expect(threads.spawned).toHaveLength(2);
    expect(threads.spawned[1].prompt).toContain("### a1: GHSA-35jh-r3h4-6jhm");
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0].body).toContain("High · dependency advisory");
    expect(gh.comments[0].body).toContain("**Reachable.**");
    expect(gh.writes).toContain(`PATCH /pulls/comments/${commentId}`);
    expect(gh.summary()).toContain("- **High** `package.json:");
    expect(store.state()?.findings[0]).toMatchObject({ severity: "high", reach: { reachable: "yes" }, status: "open" });
  });

  it("never posts again a finding a person dismissed by resolving its thread", async () => {
    const { gh, store, run } = setup();
    gh.dependencies({}, { lodash: "4.17.20" });
    gh.vulns["lodash@4.17.20"] = [LODASH_ADVISORY];
    await run("e1");
    gh.resolved.set(gh.comments[0].id, "maintainer");
    gh.head = H2;
    await run("e2");
    expect(gh.comments).toHaveLength(1);
    expect(store.state()?.findings[0].status).toBe("dismissed");
    expect(gh.summary()).toContain("No open findings.");
  });

  it("removing every dependency change resolves the open findings", async () => {
    const { gh, store, run } = setup();
    gh.dependencies({}, { lodash: "4.17.20" });
    gh.vulns["lodash@4.17.20"] = [LODASH_ADVISORY];
    await run("e1");
    gh.head = H2;
    gh.changed = [];
    await run("e2");
    expect(store.state()?.findings[0].status).toBe("resolved");
    expect(gh.comments[0].body).toContain("**Resolved in `2222222`.**");
  });

  it("flags a new look-alike package with an install script; minSeverity hides what is below it", async () => {
    const { gh, run } = setup(reachable("yes"));
    gh.dependencies({}, { lodahs: "1.0.0" });
    gh.npmCreated.lodahs = "2026-11-19T00:00:00Z";
    gh.npmVersions["lodahs@1.0.0"] = { license: "MIT", scripts: { postinstall: "node x.js" }, maintainers: [{ name: "new" }], _npmUser: { name: "new" } };
    await run("e1");
    expect(gh.comments.map((c) => c.body.split("\n")[0]).sort()).toEqual(["Medium · install script", "Medium · new package", "Medium · possible typosquat"]);

    const strict = setup(reachable("yes"), { minSeverity: "high" });
    strict.gh.dependencies({}, { lodahs: "1.0.0" });
    strict.gh.npmCreated.lodahs = "2026-11-19T00:00:00Z";
    await strict.run("e1");
    expect(strict.gh.comments).toEqual([]);
    expect(strict.gh.summary()).toContain("2 finding(s) are not shown: below the line's minimum severity.");
  });

  it("lists a finding whose line is outside the diff in the summary, with its text", async () => {
    const { gh, run } = setup();
    gh.dependencies({}, { lodash: "4.17.20" });
    gh.changed = gh.changed.map((f) => ({ ...f, patch: undefined }));
    gh.vulns["lodash@4.17.20"] = [LODASH_ADVISORY];
    await run("e1");
    expect(gh.comments).toEqual([]);
    expect(gh.summary()).toContain("<details><summary>Findings outside the diff (1)</summary>");
    expect(gh.summary()).toContain("<!-- valet-dependency-review:finding d1 high advisory -->");
  });

  it("fails the delivery when OSV is down, before posting anything", async () => {
    const { gh, run } = setup();
    gh.dependencies({}, { lodash: "4.17.20" });
    gh.osvDown = true;
    await expect(run("e1")).rejects.toThrow(/OSV advisory lookup failed \(503\)/);
    expect(gh.writes).toEqual([]);
  });

  it("skips a draft unless the line checks drafts", async () => {
    const accept = (config: Record<string, unknown>, e: PluginEvent) => acceptsDependencyEvent(e, { config: Value.Default(DependencySettingsSchema, structuredClone(config)) as Record<string, unknown>, appLogin: async () => null });
    expect(accept({}, event("e", "github.pull_request.synchronize", true))).toBe(false);
    expect(accept({ reviewDrafts: true }, event("e", "github.pull_request.synchronize", true))).toBe(true);
    expect(accept({}, event("e", "github.pull_request.ready_for_review", false))).toBe(true);
    expect(accept({}, event("e"))).toBe(true);
  });

  it("is a second handler of the pr-review plugin, with its own role", async () => {
    const plugin = (await import("../src/plugin.js")).default;
    expect(plugin.eventHandlers?.map((h) => h.id)).toEqual(["review-pull-request", "review-dependencies"]);
    expect(plugin.roles?.some((r) => r.name === REACHABILITY_ROLE)).toBe(true);
  });
});
