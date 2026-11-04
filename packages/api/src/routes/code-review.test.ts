import { afterEach, expect, it } from "vitest";
import type { PullPointers } from "@valet/plugin-pr-review";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { ensureAssistantExecution } from "../assistants/service.js";
import { pluginThreadKey } from "../plugins/plugin-thread-key.js";
import { pluginStore } from "../services/plugin-store.js";
import type { ListCodeReviewsResponse } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

const owner = { type: "user", id: "local-user" } as const;
const meta = { orgId: "local-org", actorUserId: "local-user" };

function pointers(over: Partial<PullPointers>): PullPointers {
  return { version: 1, findings: [], nextId: 1, ...over };
}

async function reviews(query = ""): Promise<{ status: number; body: ListCodeReviewsResponse }> {
  const res = await fetch(`${api!.baseUrl}/api/code-review/reviews${query}`);
  return { status: res.status, body: await res.json() as ListCodeReviewsResponse };
}

it("lists the workspace's reviewed pull requests, newest first, with counts and the plugin thread", async () => {
  api = await bootTestApi();
  const store = pluginStore(api.providers.db, "pr-review").user(owner.id);
  await store.put("pulls", "acme/site#7", pointers({
    reviewId: 41,
    lastReviewedHead: "abc123",
    findings: [
      { id: "f1", path: "a.ts", line: 1, status: "open" },
      { id: "f2", path: "a.ts", line: 9, status: "resolved", fixedIn: "abc123" },
      { id: "f3", path: "b.ts", line: 2, status: "dismissed" },
    ],
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
  expect(body.reviews[1]).toMatchObject({ repo: "acme/site", number: 7, reviewId: 41, head: "abc123", openFindings: 1, resolvedFindings: 1, threadId: thread.id });
  expect(body.reviews[0]).toEqual({ repo: "acme/site", number: 8, openFindings: 0, resolvedFindings: 0, updatedAt: expect.any(Number) });
});

it("refuses a team the caller cannot see", async () => {
  api = await bootTestApi();
  const { status } = await reviews("?teamId=team-nope");
  expect(status).toBe(404);
});
