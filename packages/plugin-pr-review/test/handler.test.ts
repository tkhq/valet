/**
 * The review handler with fake threads, store and GitHub: what it posts on
 * the first push, how a later push edits the same review, and when it
 * skips.
 */
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import type {
  PluginChild,
  PluginChildRequest,
  PluginEvent,
  PluginEventContext,
  PluginStoreDoc,
  PluginThreadRef,
  PluginThreads,
  ScopedPluginStore,
  SubmissionResult,
} from "@valet/engine";
import {
  commentableLines,
  createReviewHandler,
  excluded,
  parseFindings,
  renderFinding,
  ReviewSettingsSchema,
  type Finding,
  type PullPointers,
  type Review,
  type Verdict,
} from "../src/index.js";

const OWNER = "acme";
const REPO = "site";
const SLUG = "acme/site#7";
const BASE = "b".repeat(40);
const H1 = "1".repeat(40);
const H2 = "2".repeat(40);

/** a.ts lines 1-20 are in the diff's one hunk; b.ts is not changed. */
const PATCH_A = "@@ -1,3 +1,20 @@\n" + Array.from({ length: 20 }, (_, i) => `+line ${i + 1}`).join("\n");
const DIFF = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n${PATCH_A}\n`;

interface GhComment {
  id: number;
  path: string;
  line: number;
  body: string;
  pull_request_review_id: number;
}

/** An in-memory GitHub for one pull request. */
class FakeGitHub {
  head = H1;
  draft = false;
  forkHead = false;
  /** `status` of compare(last reviewed head, head). */
  incrementStatus: "ahead" | "diverged" = "ahead";
  incrementFiles: string[] = ["a.ts"];
  reviews = new Map<number, { id: number; body: string; commit_id: string }>();
  comments: GhComment[] = [];
  refuseInline = false;
  writes: string[] = [];
  private nextId = 100;

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(`/repos/${OWNER}/${REPO}`, "");
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const ok = (data: unknown): Response => new Response(typeof data === "string" ? data : JSON.stringify(data), { status: 200 });
    if (method !== "GET") this.writes.push(`${method} ${path}`);

    if (method === "GET" && path === "/pulls/7") {
      return ok({
        number: 7,
        state: "open",
        draft: this.draft,
        title: "Add a.ts",
        body: "Adds a.",
        html_url: "https://github.com/acme/site/pull/7",
        head: { sha: this.head, ref: "feature", repo: { full_name: this.forkHead ? "someone/site" : "acme/site" } },
        base: { sha: BASE, ref: "main", repo: { full_name: "acme/site" } },
      });
    }
    if (method === "GET" && path.startsWith("/compare/")) {
      const [from] = path.slice("/compare/".length).split("...");
      if ((init?.headers as Record<string, string>).accept === "application/vnd.github.diff") return ok(DIFF);
      if (from === BASE) return ok({ status: "ahead", merge_base_commit: { sha: BASE }, files: [{ filename: "a.ts" }] });
      return ok({ status: this.incrementStatus, merge_base_commit: { sha: from }, files: this.incrementFiles.map((filename) => ({ filename })) });
    }
    if (method === "GET" && path === "/pulls/7/files") {
      return ok(url.searchParams.get("page") === "1" ? [{ filename: "a.ts", status: "modified", additions: 20, deletions: 3, patch: PATCH_A }] : []);
    }
    if (method === "GET" && path.startsWith("/contents/")) return ok(Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"));
    if (method === "GET" && path === "/pulls/7/comments") {
      const all = this.comments.map((c) => ({ ...c, original_line: c.line, html_url: `https://github.com/c/${c.id}` }));
      return ok(url.searchParams.get("page") === "1" ? all : []);
    }
    const reviewMatch = /^\/pulls\/7\/reviews\/(\d+)$/.exec(path);
    if (reviewMatch) {
      const review = this.reviews.get(Number(reviewMatch[1]));
      if (!review) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      if (method === "PUT") review.body = String(body.body);
      return ok({ ...review, html_url: "https://github.com/r" });
    }
    if (method === "POST" && path === "/pulls/7/reviews") {
      const comments = (body.comments as { path: string; line: number; body: string }[]) ?? [];
      if (this.refuseInline && comments.length > 0) return new Response(JSON.stringify({ message: "Line could not be resolved" }), { status: 422 });
      const id = this.nextId++;
      this.reviews.set(id, { id, body: String(body.body ?? ""), commit_id: String(body.commit_id) });
      for (const c of comments) this.comments.push({ id: this.nextId++, path: c.path, line: c.line, body: c.body, pull_request_review_id: id });
      return ok({ id, body: body.body, html_url: "https://github.com/r" });
    }
    const commentMatch = /^\/pulls\/comments\/(\d+)$/.exec(path);
    if (method === "PATCH" && commentMatch) {
      const comment = this.comments.find((c) => c.id === Number(commentMatch[1]));
      if (comment) comment.body = String(body.body);
      return ok({});
    }
    return new Response(JSON.stringify({ message: `unexpected ${method} ${path}` }), { status: 500 });
  };
}

class FakeStore implements ScopedPluginStore {
  docs = new Map<string, PluginStoreDoc<unknown>>();
  async get<T>(collection: string, key: string): Promise<PluginStoreDoc<T> | null> {
    // Test-only store: each key holds whatever the handler put there.
    return (this.docs.get(`${collection}/${key}`) as PluginStoreDoc<T> | undefined) ?? null;
  }
  async put<T>(collection: string, key: string, doc: T, opts?: { ifRevision?: number }): Promise<PluginStoreDoc<T>> {
    const current = this.docs.get(`${collection}/${key}`);
    if (opts?.ifRevision !== undefined && current?.revision !== opts.ifRevision) throw new Error("revision moved");
    const now = Date.now();
    const next: PluginStoreDoc<T> = { key, doc, revision: (current?.revision ?? 0) + 1, createdAt: current?.createdAt ?? now, updatedAt: now };
    this.docs.set(`${collection}/${key}`, next);
    return next;
  }
  async list<T>(): Promise<{ items: PluginStoreDoc<T>[]; nextCursor: string | null }> {
    return { items: [], nextCursor: null };
  }
  async delete(): Promise<boolean> {
    return false;
  }
  pointers(): PullPointers | undefined {
    return this.docs.get(`pulls/${SLUG}`)?.doc as PullPointers | undefined;
  }
}

type Answer = (req: PluginChildRequest) => unknown;

/** Threads whose children answer at once with what `answer` returns. */
class FakeThreads implements PluginThreads {
  spawned: { req: PluginChildRequest; dispatchId: string }[] = [];
  private requests = new Map<string, PluginChildRequest>();
  constructor(private answer: Answer) {}
  async ensure(key: string): Promise<PluginThreadRef> {
    return { sessionId: "s1", threadId: "t1", key: `plugin:pr-review:${key}` };
  }
  async post(): Promise<never> {
    throw new Error("the review handler does not post to its thread");
  }
  async awaitReply(): Promise<never> {
    throw new Error("the review handler does not post to its thread");
  }
  async spawnChild(_thread: PluginThreadRef, req: PluginChildRequest, opts: { dispatchId: string }): Promise<PluginChild> {
    this.spawned.push({ req, dispatchId: opts.dispatchId });
    this.requests.set(opts.dispatchId, req);
    return { childSessionId: opts.dispatchId, queueItemId: `q-${opts.dispatchId}` };
  }
  async awaitChild(child: PluginChild): Promise<SubmissionResult> {
    const req = this.requests.get(child.childSessionId);
    if (!req) throw new Error(`unknown child ${child.childSessionId}`);
    return { queueItemId: child.queueItemId, outcome: "completed", output: this.answer(req) };
  }
  async stopChild(): Promise<{ stopped: number }> {
    return { stopped: 0 };
  }
}

const finding = (over: Partial<Finding>): Finding => ({
  path: "a.ts",
  line: 5,
  severity: "high",
  category: "bug",
  title: "Null deref in parse",
  body: "An empty input makes parse read undefined.",
  ...over,
});

const verdict = (v: Verdict["verdict"], over: Partial<Verdict> = {}): Verdict => ({
  located_code: "line 5",
  evidence: "a.ts:5 reads input[0]",
  trigger: "empty input",
  introduced_by_pr: true,
  counter_evidence: v === "refuted" ? "a.ts:4 returns early on empty input" : "",
  verdict: v,
  ...(v === "refuted" ? { refutation_reason: "guarded" as const } : {}),
  ...over,
});

/** Answers from a script: the reviewer returns `review`; each verifier answers by finding title. */
function scripted(review: Review, verdicts: Record<string, Verdict>): Answer {
  return (req) => {
    if (req.role === "pr-reviewer") return review;
    const title = /^Title: (.*)$/m.exec(req.prompt)?.[1] ?? "";
    return verdicts[title] ?? verdict("confirmed");
  };
}

function event(id: string, key = "github.pull_request.synchronize"): PluginEvent {
  return {
    id,
    key,
    dedupeKey: `d-${id}`,
    occurredAt: new Date().toISOString(),
    refs: { repo: "acme/site" },
    summary: "PR #7 updated",
    payload: { action: "synchronize", pull_request: { number: 7 } },
  };
}

function context(threads: PluginThreads, store: ScopedPluginStore, config: Record<string, unknown> = {}): PluginEventContext {
  return {
    orgId: "org-1",
    owner: { type: "user", id: "user-1" },
    actorUserId: "user-1",
    threads,
    // As the host passes it: checked against the schema with defaults filled in.
    config: Value.Default(ReviewSettingsSchema, structuredClone(config)) as Record<string, unknown>,
    store,
    memory: { search: async () => [], read: async () => null },
    appToken: async (service) => (service === "github" ? "ghs_test" : null),
    signal: new AbortController().signal,
  };
}

const reviewOf = (findings: Finding[]): Review => ({ summary: "Adds a.ts.", confidence: 3, findings });

describe("review-pull-request handler", () => {
  it("posts one review with inline and summary findings on the first push", async () => {
    const gh = new FakeGitHub();
    const store = new FakeStore();
    const threads = new FakeThreads(
      scripted(
        reviewOf([
          finding({ title: "Null deref in parse" }),
          finding({ line: 40, title: "Off by one past the diff", severity: "medium" }),
          finding({ line: 9, title: "Refuted race in cache" }),
        ]),
        { "Refuted race in cache": verdict("refuted") },
      ),
    );
    await createReviewHandler({ fetch: gh.fetch }).handle(event("ev1", "github.pull_request.opened"), context(threads, store));

    expect(gh.reviews.size).toBe(1);
    const [review] = [...gh.reviews.values()];
    expect(review.commit_id).toBe(H1);
    expect(review.body).toContain(`valet-pr-review:summary ${H1}`);
    expect(review.body).toContain("Open findings (2)");
    // Line 40 is outside the diff, so its text lives in the summary.
    expect(parseFindings(review.body).get("f2")?.title).toBe("Off by one past the diff");
    expect(review.body).not.toContain("Refuted race");
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]).toMatchObject({ path: "a.ts", line: 5, pull_request_review_id: review.id });

    const reviewer = threads.spawned.find((s) => s.req.role === "pr-reviewer");
    expect(reviewer?.req).toMatchObject({ repo: "acme/site", ref: H1, model: "anthropic/claude-sonnet-5-5" });
    expect(reviewer?.req.prompt).toContain("```json");
    // The spec asks for the event id in every dispatch id.
    expect(threads.spawned.every((s) => s.dispatchId.startsWith(`ev1:${H1.slice(0, 12)}:`))).toBe(true);

    expect(store.pointers()).toEqual({
      version: 1,
      reviewId: review.id,
      lastReviewedHead: H1,
      nextId: 3,
      findings: [
        { id: "f1", path: "a.ts", line: 5, status: "open", commentId: gh.comments[0].id },
        { id: "f2", path: "a.ts", line: 40, status: "open" },
      ],
    });
  });

  it("edits the same review on the next push, marks fixed findings and reviews only new commits", async () => {
    const gh = new FakeGitHub();
    const store = new FakeStore();
    const first = new FakeThreads(scripted(reviewOf([finding({ title: "Null deref in parse" })]), {}));
    const handler = createReviewHandler({ fetch: gh.fetch });
    await handler.handle(event("ev1"), context(first, store));
    const summaryId = store.pointers()?.reviewId;
    const commentId = gh.comments[0].id;

    gh.head = H2;
    const second = new FakeThreads(
      scripted(reviewOf([finding({ line: 12, title: "Leaked handle in close", severity: "medium" })]), {
        "Null deref in parse": verdict("refuted", { counter_evidence: "a.ts:4 now returns early" }),
      }),
    );
    await handler.handle(event("ev2"), context(second, store));

    const recheck = second.spawned.find((s) => s.dispatchId.endsWith(":recheck:f1"));
    expect(recheck?.req.prompt).toContain(`posted this claim on commit ${H1}`);
    const reviewer = second.spawned.find((s) => s.req.role === "pr-reviewer");
    expect(reviewer?.req.prompt).toContain(`already reviewed at commit ${H1}`);
    expect(reviewer?.req.prompt).toContain("- a.ts:5 Null deref in parse");

    // The summary review is the same one, edited; the new finding comes in a follow-up review.
    expect(gh.writes).toContain(`PUT /pulls/7/reviews/${summaryId}`);
    const summary = gh.reviews.get(summaryId ?? -1);
    expect(summary?.body).toContain(`valet-pr-review:summary ${H2}`);
    expect(summary?.body).toContain("Fixed (1)");
    expect(summary?.body).toContain("Open findings (1)");
    expect(gh.reviews.size).toBe(2);
    expect(gh.comments.find((c) => c.id === commentId)?.body).toMatch(/^\*\*Fixed in `2222222`\.\*\* a\.ts:4 now returns early/);

    expect(store.pointers()).toMatchObject({
      reviewId: summaryId,
      lastReviewedHead: H2,
      nextId: 3,
      findings: [
        { id: "f1", status: "resolved", fixedIn: H2, commentId },
        { id: "f2", path: "a.ts", line: 12, status: "open" },
      ],
    });
  });

  it("keeps an open finding in an unchanged file without a recheck", async () => {
    const gh = new FakeGitHub();
    const store = new FakeStore();
    const handler = createReviewHandler({ fetch: gh.fetch });
    await handler.handle(event("ev1"), context(new FakeThreads(scripted(reviewOf([finding({})]), {})), store));
    gh.head = H2;
    gh.incrementFiles = ["c.ts"];
    const second = new FakeThreads(scripted(reviewOf([]), {}));
    await handler.handle(event("ev2"), context(second, store));
    expect(second.spawned.map((s) => s.req.role)).toEqual(["pr-reviewer"]);
    expect(store.pointers()?.findings).toMatchObject([{ id: "f1", status: "open" }]);
  });

  it("rechecks every open finding and reviews the whole PR after a force-push", async () => {
    const gh = new FakeGitHub();
    const store = new FakeStore();
    const handler = createReviewHandler({ fetch: gh.fetch });
    await handler.handle(event("ev1"), context(new FakeThreads(scripted(reviewOf([finding({})]), {})), store));
    gh.head = H2;
    gh.incrementStatus = "diverged";
    gh.incrementFiles = [];
    const second = new FakeThreads(scripted(reviewOf([]), {}));
    await handler.handle(event("ev2"), context(second, store));
    expect(second.spawned.some((s) => s.dispatchId.endsWith(":recheck:f1"))).toBe(true);
    expect(second.spawned.find((s) => s.req.role === "pr-reviewer")?.req.prompt).not.toContain("Follow-up review");
  });

  it("does nothing for a head it already reviewed", async () => {
    const gh = new FakeGitHub();
    const store = new FakeStore();
    const handler = createReviewHandler({ fetch: gh.fetch });
    await handler.handle(event("ev1"), context(new FakeThreads(scripted(reviewOf([]), {})), store));
    const writes = gh.writes.length;
    const again = new FakeThreads(scripted(reviewOf([]), {}));
    await handler.handle(event("ev2"), context(again, store));
    expect(again.spawned).toHaveLength(0);
    expect(gh.writes).toHaveLength(writes);
  });

  it("skips drafts unless the line reviews them", async () => {
    const gh = new FakeGitHub();
    gh.draft = true;
    const store = new FakeStore();
    const threads = new FakeThreads(scripted(reviewOf([]), {}));
    await createReviewHandler({ fetch: gh.fetch }).handle(event("ev1"), context(threads, store));
    expect(threads.spawned).toHaveLength(0);
    await createReviewHandler({ fetch: gh.fetch }).handle(event("ev1"), context(threads, store, { reviewDrafts: true }));
    expect(threads.spawned).toHaveLength(1);
  });

  it("posts a notice and starts no child for a pull request from a fork", async () => {
    const gh = new FakeGitHub();
    gh.forkHead = true;
    const store = new FakeStore();
    const threads = new FakeThreads(scripted(reviewOf([]), {}));
    await createReviewHandler({ fetch: gh.fetch }).handle(event("ev1"), context(threads, store));
    expect(threads.spawned).toHaveLength(0);
    expect([...gh.reviews.values()][0].body).toContain("does not review pull requests from forks");
    expect(store.pointers()?.lastReviewedHead).toBe(H1);
  });

  it("hides findings below the minimum severity and in excluded paths", async () => {
    const gh = new FakeGitHub();
    const store = new FakeStore();
    const threads = new FakeThreads(
      scripted(reviewOf([finding({ severity: "low", title: "Minor nit" }), finding({ path: "gen/x.ts", title: "Generated" }), finding({ line: 6, title: "Real bug" })]), {}),
    );
    await createReviewHandler({ fetch: gh.fetch }).handle(event("ev1"), context(threads, store, { minSeverity: "medium", excludePaths: ["gen/"] }));
    const body = [...gh.reviews.values()][0].body;
    expect(body).toContain("Open findings (1)");
    expect(body).toContain("2 finding(s) below the line's minimum severity or in excluded paths");
    expect(threads.spawned.find((s) => s.req.role === "pr-reviewer")?.req.prompt).toContain("- `gen/`");
  });

  it("moves inline findings into the summary when GitHub refuses their lines", async () => {
    const gh = new FakeGitHub();
    gh.refuseInline = true;
    const store = new FakeStore();
    await createReviewHandler({ fetch: gh.fetch }).handle(event("ev1"), context(new FakeThreads(scripted(reviewOf([finding({})]), {})), store));
    const [review] = [...gh.reviews.values()];
    expect(parseFindings(review.body).has("f1")).toBe(true);
    expect(store.pointers()?.findings).toEqual([{ id: "f1", path: "a.ts", line: 5, status: "open" }]);
  });

  it("fails the delivery when the GitHub App is not installed", async () => {
    const ctx = { ...context(new FakeThreads(scripted(reviewOf([]), {})), new FakeStore()), appToken: async () => null };
    await expect(createReviewHandler().handle(event("ev1"), ctx)).rejects.toThrow(/Install it on acme/);
  });
});

describe("review helpers", () => {
  it("matches exclude globs", () => {
    expect(excluded("pnpm-lock.yaml", ["*.yaml"])).toBe(true);
    expect(excluded("deep/dir/x.lock", ["*.lock"])).toBe(true);
    expect(excluded("dist/a/b.js", ["dist/"])).toBe(true);
    expect(excluded("src/dist.ts", ["dist/"])).toBe(false);
    expect(excluded("packages/web/gen/x.ts", ["packages/**/gen/*.ts"])).toBe(true);
    expect(excluded("packages/web/src/x.ts", ["packages/*/gen/**"])).toBe(false);
  });

  it("lists the lines a review comment can anchor to", () => {
    expect([...commentableLines("@@ -10,3 +10,4 @@\n ctx\n-old\n+new\n+added\n ctx2\n\\ No newline at end of file")]).toEqual([10, 11, 12, 13]);
  });

  it("reads back a finding it rendered", () => {
    const f = { ...finding({ suggestion: "if (!x) return;\n" }), id: "f9" };
    const parsed = parseFindings(`Intro\n\n${renderFinding(f)}\n\nOutro`).get("f9");
    expect(parsed).toEqual({ id: "f9", severity: "high", category: "bug", title: f.title, body: f.body, suggestion: "if (!x) return;" });
  });
});
