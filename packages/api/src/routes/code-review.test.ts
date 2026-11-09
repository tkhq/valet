import { afterEach, expect, it, vi } from "vitest";
import type { PullPointers, PullRequestReviewState } from "@valet/plugin-pr-review";
import githubPlugin from "@valet/plugin-github/plugin";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { ensureAssistantExecution } from "../assistants/service.js";
import { pluginThreadKey } from "../plugins/plugin-thread-key.js";
import { pluginStore } from "../services/plugin-store.js";
import { eventDeliveries, events, eventSubscriptions, teams } from "../schema/index.js";
import { startGithubFixture, type GithubFixture, type GithubFixtureHandlers } from "../test-helpers/github-fixture.js";
import type { ListCodeReviewsResponse } from "../wire/types.js";

let api: TestApi | undefined;
let github: GithubFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await api?.cleanup(); api = undefined; await github?.close(); github = undefined; vi.unstubAllEnvs(); });

const owner = { type: "user", id: "local-user" } as const;
const meta = { orgId: "local-org", actorUserId: "local-user" };

function pointers(over: Partial<PullPointers>): PullPointers {
  return { version: 1, findings: [], nextId: 1, ...over };
}

async function reviews(query = ""): Promise<{ status: number; body: ListCodeReviewsResponse }> {
  const res = await fetch(`${api!.baseUrl}/api/code-review/reviews${query}`);
  return { status: res.status, body: await res.json() as ListCodeReviewsResponse };
}

async function bootWithGitHub(getPull: GithubFixtureHandlers["getPull"] = (_owner, _repo, number) => ({
  body: { state: "open", title: `Pull request ${number}`, html_url: `https://github.com/acme/site/pull/${number}` },
})) {
  github = await startGithubFixture({ getPull });
  vi.stubEnv("GITHUB_API_URL", github.url);
  api = await bootTestApi({ plugins: [githubPlugin] });
  await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "github", { type: "oauth2", accessToken: "org-token" });
  return api;
}

async function seedDelivery(local: TestApi, number: number, status: "pending" | "failed" | "dead" | "delivered", at: number, ownerId: string = owner.id) {
  const id = `${ownerId}-${number}-${at}`;
  await local.providers.db.insert(eventSubscriptions).values({
    id, orgId: "local-org", ownerType: "user", ownerId, name: "Review PRs", eventKeys: ["github.pull_request.*"],
    filters: [], target: { kind: "plugin", plugin: "pr-review", handler: "review-pull-request" },
    createdBy: "local-user", createdAt: at, updatedAt: at,
  });
  await local.providers.db.insert(events).values({
    id, orgId: "local-org", service: "github", eventKey: "github.pull_request.synchronize", dedupeKey: id,
    refs: { repo: "acme/site" }, summary: "Pull request updated", payload: { pull_request: { number } }, occurredAt: at, receivedAt: at,
  });
  await local.providers.db.insert(eventDeliveries).values({ id, eventId: id, subscriptionId: id, status, nextAttemptAt: at, createdAt: at });
}

it("lists the workspace's reviewed pull requests, newest first, with counts and the plugin thread", async () => {
  api = await bootWithGitHub();
  const store = pluginStore(api.providers.db, "pr-review").user(owner.id);
  await store.put("pulls", "acme/site#7", pointers({
    reviewId: 41,
    lastReviewedHead: "abc123",
    findings: [
      { id: "f1", path: "a.ts", line: 1, status: "open" },
      { id: "f2", path: "a.ts", line: 9, status: "resolved", fixedIn: "abc123" },
      { id: "f3", path: "b.ts", line: 2, status: "dismissed" },
    ],
    rounds: [{ head: "abc123", mode: "full", at: "2026-11-05T12:00:00.000Z", newFindings: ["f1", "f2"], resolved: ["f2"] }],
  }));
  await store.put("pulls", "acme/site#8", pointers({}));
  // Another workspace's record and a key that names no pull request stay out.
  await pluginStore(api.providers.db, "pr-review").user("someone-else").put("pulls", "acme/site#9", pointers({}));
  await store.put("pulls", "not-a-pull", pointers({}));

  const key = pluginThreadKey("pr-review", "acme/site#7");
  const execution = await ensureAssistantExecution(api.providers, owner, meta, key, { isolated: true, title: "Review acme/site#7" });
  const thread = await execution.session.createThread(key, { title: "Review acme/site#7" });

  const { status, body } = await reviews();
  expect(status).toBe(200);
  expect(body.reviews.map((r) => `${r.repo}#${r.number}`)).toEqual(["acme/site#8", "acme/site#7"]);
  expect(body.reviews[1]).toMatchObject({ repo: "acme/site", number: 7, reviewId: 41, head: "abc123", openFindings: 1, resolvedFindings: 1, threadId: thread.id, state: "open", title: "Pull request 7", url: "https://github.com/acme/site/pull/7", status: "complete", rounds: [{ head: "abc123", mode: "full", at: "2026-11-05T12:00:00.000Z", newFindings: 2, resolved: 1 }] });
  expect(body.reviews[0]).toMatchObject({ repo: "acme/site", number: 8, openFindings: 0, resolvedFindings: 0, updatedAt: expect.any(Number) });
});

it("checks current GitHub state for old records and removes merged and closed pull requests", async () => {
  const local = await bootWithGitHub((_owner, _repo, number) => ({
    body: { state: number === "7" ? "open" : "closed", merged: number === "8", title: "Change", html_url: `https://github.com/acme/site/pull/${number}` },
  }));
  const store = pluginStore(local.providers.db, "pr-review").user(owner.id);
  for (const number of [7, 8, 9]) await store.put("pulls", `acme/site#${number}`, pointers({}));
  expect((await reviews()).body.reviews.map(r => r.number)).toEqual([7]);
});

it("includes a pending first review and groups later deliveries into its existing review chain", async () => {
  const local = await bootWithGitHub();
  const at = Date.now();
  await seedDelivery(local, 7, "delivered", at - 2);
  await seedDelivery(local, 7, "pending", at);
  await seedDelivery(local, 8, "failed", at - 1);
  await seedDelivery(local, 10, "dead", at - 3);
  await seedDelivery(local, 9, "pending", at, "someone-else");
  const key = pluginThreadKey("pr-review", "acme/site#7");
  const execution = await ensureAssistantExecution(local.providers, owner, meta, key, { isolated: true, title: "Review acme/site#7" });
  const thread = await execution.session.createThread(key);
  const { status, body } = await reviews();
  expect(status).toBe(200);
  expect(body.reviews).toEqual([
    expect.objectContaining({ number: 7, status: "running", threadId: thread.id, rounds: [] }),
    expect.objectContaining({ number: 8, status: "running" }),
    expect.objectContaining({ number: 10, status: "failed" }),
  ]);
});

it("reads legacy review rounds without a pointer record", async () => {
  const local = await bootWithGitHub();
  const state: PullRequestReviewState = {
    version: 1, key: "acme/site#7", mergeBase: "base", lastReviewedHead: "head2", nextId: 3,
    findings: [
      { id: "f1", status: "resolved", path: "a.ts", line: 1, severity: "high", category: "bug", title: "Old issue", body: "An old issue.", firstSeen: "head1", lastSeen: "head2" },
      { id: "f2", status: "open", path: "a.ts", line: 2, severity: "high", category: "bug", title: "New issue", body: "A new issue.", firstSeen: "head2", lastSeen: "head2" },
    ],
    rounds: [
      { head: "head1", mode: "full", at: "2026-11-04T12:00:00.000Z", newFindings: ["f1"], resolved: [] },
      { head: "head2", mode: "incremental", at: "2026-11-05T12:00:00.000Z", newFindings: ["f2"], resolved: ["f1"] },
    ],
  };
  await pluginStore(local.providers.db, "pr-review").user(owner.id).put("pr-review-state", "acme/site#7", state);
  expect((await reviews()).body.reviews).toEqual([expect.objectContaining({
    number: 7, head: "head2", openFindings: 1, resolvedFindings: 1,
    rounds: [
      { head: "head1", mode: "full", at: "2026-11-04T12:00:00.000Z", newFindings: 1, resolved: 0 },
      { head: "head2", mode: "incremental", at: "2026-11-05T12:00:00.000Z", newFindings: 1, resolved: 1 },
    ],
  })]);
  await pluginStore(local.providers.db, "pr-review").user(owner.id).put("pulls", "acme/site#7", pointers({
    lastReviewedHead: "head3",
    rounds: [{ head: "head3", mode: "incremental", at: "2026-11-05T13:00:00.000Z", newFindings: [], resolved: ["f2"] }],
  }));
  expect((await reviews()).body.reviews[0]?.rounds).toEqual([
    { head: "head1", mode: "full", at: "2026-11-04T12:00:00.000Z", newFindings: 1, resolved: 0 },
    { head: "head2", mode: "incremental", at: "2026-11-05T12:00:00.000Z", newFindings: 1, resolved: 1 },
    { head: "head3", mode: "incremental", at: "2026-11-05T13:00:00.000Z", newFindings: 0, resolved: 1 },
  ]);
});

it("fails explicitly when GitHub returns an invalid pull request state", async () => {
  const local = await bootWithGitHub(() => ({ body: { state: "unknown", title: "Change", html_url: "https://github.com/acme/site/pull/7" } }));
  await pluginStore(local.providers.db, "pr-review").user(owner.id).put("pulls", "acme/site#7", pointers({}));
  const response = await fetch(`${local.baseUrl}/api/code-review/reviews`);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining("try again") });
});

it.each([503, 403, 404] as const)("returns an explicit error when GitHub cannot verify a pull request (%s)", async (status) => {
  const local = await bootWithGitHub(() => ({ status, body: { message: "Unavailable" } }));
  await pluginStore(local.providers.db, "pr-review").user(owner.id).put("pulls", "acme/site#7", pointers({}));
  const response = await fetch(`${local.baseUrl}/api/code-review/reviews`);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: expect.stringMatching(/GitHub.*(retry|try again|Settings)/i) });
});

it("fails explicitly when GitHub access is missing", async () => {
  api = await bootTestApi();
  await pluginStore(api.providers.db, "pr-review").user(owner.id).put("pulls", "acme/site#7", pointers({}));
  const response = await fetch(`${api.baseUrl}/api/code-review/reviews`);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining("GitHub") });
});

it("returns an error when the deadline expires during credential resolution", async () => {
  const local = await bootWithGitHub();
  await pluginStore(local.providers.db, "pr-review").user(owner.id).put("pulls", "acme/site#7", pointers({}));
  const deadline = new AbortController();
  const request = new AbortController();
  const read = vi.spyOn(local.providers.engineCredentials, "get").mockImplementation(() => new Promise(() => {}));
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const response = fetch(`${local.baseUrl}/api/code-review/reviews`, { signal: request.signal });
  try {
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    deadline.abort(new Error("Deadline expired"));
    const status = await Promise.race([response.then(r => r.status), new Promise(resolve => setTimeout(() => resolve("timed out"), 200))]);
    expect(status).toBe(503);
  } finally {
    request.abort();
    await response.catch(() => {});
  }
});

it("keeps personal records out of the team view", async () => {
  const local = await bootWithGitHub();
  const now = Date.now();
  await local.providers.db.insert(teams).values({ id: "team-1", orgId: "local-org", name: "Team", createdAt: now });
  await pluginStore(local.providers.db, "pr-review").user(owner.id).put("pulls", "acme/site#7", pointers({}));
  await pluginStore(local.providers.db, "pr-review").team("team-1").put("pulls", "acme/site#8", pointers({}));
  const result = await reviews("?teamId=team-1");
  expect(result.status).toBe(200);
  expect(result.body.reviews.map(r => r.number)).toEqual([8]);
});

it("refuses a team the caller cannot see", async () => {
  api = await bootTestApi();
  const { status } = await reviews("?teamId=team-nope");
  expect(status).toBe(404);
});

async function run(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${api!.baseUrl}/api/code-review/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function seedLine(local: TestApi, repo: string, ownerId: string = owner.id) {
  const now = Date.now();
  await local.providers.db.insert(eventSubscriptions).values({
    id: `line-${repo}-${ownerId}`, orgId: "local-org", ownerType: "user", ownerId, name: `Code review: ${repo}`,
    eventKeys: ["github.pull_request.opened", "github.pull_request.synchronize"],
    filters: [{ op: "eq", field: "repo", value: repo }], target: { kind: "plugin", plugin: "pr-review", handler: "review-pull-request" },
    createdBy: "local-user", createdAt: now, updatedAt: now,
  });
}

// The fixture passes the number from the URL path as text.
const pullBody = (state: "open" | "closed") => (_owner: string, _repo: string, number: string) => ({
  body: { number: Number(number), state, title: `Pull request ${number}`, html_url: `https://github.com/acme/site/pull/${number}`, base: { ref: "main", repo: { full_name: "acme/site" } }, head: { ref: "f", sha: "abc" } },
});

it("starts a review of a pull request through the workspace's line, on the handler's delivery path", async () => {
  api = await bootWithGitHub(pullBody("open"));
  await seedLine(api, "acme/site");
  const res = await run({ url: "https://github.com/acme/site/pull/7" });
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ subscriptionId: "line-acme/site-local-user", shadow: false });
  const [event] = await api.providers.db.select().from(events);
  expect(event).toMatchObject({ service: "github", eventKey: "github.pull_request.valet_review_requested", refs: { repo: "acme/site", pr_number: "7" }, subjects: ["github:acme", "github:acme/site", "github:acme/site#7"] });
  expect(event.payload).toMatchObject({ pull_request: { number: 7 }, valet: { requestedBy: "local-user" } });
  const deliveries = await api.providers.db.select().from(eventDeliveries);
  expect(deliveries).toMatchObject([{ eventId: event.id, subscriptionId: "line-acme/site-local-user" }]);
});

it("shadow-reviews a closed pull request at a commit, and refuses one outside shadow mode", async () => {
  api = await bootWithGitHub(pullBody("closed"));
  await seedLine(api, "acme/site");
  expect((await run({ url: "https://github.com/acme/site/pull/7" })).status).toBe(409);
  const res = await run({ url: "https://github.com/acme/site/pull/7", shadow: true, commit: "abcdef1" });
  expect(res.status).toBe(201);
  const [event] = await api.providers.db.select().from(events);
  expect(event.payload).toMatchObject({ valet: { shadow: true, commit: "abcdef1" } });
});

it("refuses a bad URL, a commit without shadow mode, and a repository no line in the workspace covers", async () => {
  api = await bootWithGitHub(pullBody("open"));
  await seedLine(api, "acme/other");
  await seedLine(api, "acme/site", "someone-else");
  expect((await run({ url: "https://gitlab.com/acme/site/merge_requests/7" })).status).toBe(400);
  expect((await run({ url: "https://github.com/acme/site/pull/7", commit: "abcdef1" })).status).toBe(400);
  const missing = await run({ url: "https://github.com/acme/site/pull/7" });
  expect(missing.status).toBe(404);
  expect(String(missing.body.error)).toContain("Turn the repository on in Code review first");
  expect(await api.providers.db.select().from(events)).toHaveLength(0);
});
