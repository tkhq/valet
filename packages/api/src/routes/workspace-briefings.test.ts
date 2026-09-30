import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { sessionThreads, workspaceBriefingCache } from "../schema/index.js";
import type { DismissWorkspaceBriefingResponse, WorkspaceBriefing } from "../wire/types.js";
import { hideDismissedBriefings } from "./workspace-briefings.js";

// The api project runs with `isolate: false`, so a module mock would not
// reach an app another test file already loaded. The GET filter is tested
// through the exported function instead of a mocked generator.
const briefs: WorkspaceBriefing[] = ["a", "b"].map((letter) => ({
  id: `brief:${letter.repeat(24)}`, title: `Brief ${letter}`, summary: "Summary.", status: "updated",
  updatedAt: 1, latestThread: null, sources: [],
}));

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

async function createThread(baseUrl: string): Promise<{ id: string; sessionId: string }> {
  const res = await fetch(`${baseUrl}/api/threads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  return await res.json() as { id: string; sessionId: string };
}

it("hides a dismissed brief for the caller and archives its threads, except one waiting on an approval", async () => {
  api = await bootTestApi();
  const plain = await createThread(api.baseUrl);
  const waiting = await createThread(api.baseUrl);
  const unrelated = await createThread(api.baseUrl);
  await api.providers.engineStore.saveDecisionGate(waiting.sessionId, waiting.id, {
    id: "gate-waiting", sessionId: waiting.sessionId, threadId: waiting.id, queueItemId: "q", resumeKey: "rk", ordinal: 0,
    type: "approval", title: "Approve?", actions: [{ id: "approve", label: "Approve" }], status: "pending", createdAt: 1, updatedAt: 1,
  });
  // The server's copy of the brief names its threads; the request cannot add others.
  const withThreads: WorkspaceBriefing = { ...briefs[0]!, latestThread: { sessionId: plain.sessionId, threadId: plain.id },
    sources: [{ id: "t", kind: "thread", title: "Waiting", updatedAt: 1, sessionId: waiting.sessionId, threadId: waiting.id }] };
  await api.providers.db.insert(workspaceBriefingCache).values({ orgId: "local-org", ownerType: "user", ownerId: "local-user",
    version: "v", response: { briefings: [withThreads, briefs[1]!], generatedAt: 1, coverage: "recent" } });

  const dismiss = await fetch(`${api.baseUrl}/api/workspaces/user/briefings/${briefs[0]!.id}/dismiss`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threads: [{ sessionId: unrelated.sessionId, threadId: unrelated.id }] }),
  });
  expect(dismiss.status).toBe(200);
  expect(await dismiss.json() as DismissWorkspaceBriefingResponse).toEqual({ dismissed: true, archived: 1, keptWaiting: 1 });

  const user = { type: "user", id: "local-user" } as const;
  const visible = await hideDismissedBriefings(api.providers.db, "local-user", user, { briefings: briefs, generatedAt: 1, coverage: "recent" });
  expect(visible.briefings.map((brief) => brief.id)).toEqual([briefs[1]!.id]);
  // Another person in the same workspace still sees it.
  const other = await hideDismissedBriefings(api.providers.db, "another-user", user, { briefings: briefs, generatedAt: 1, coverage: "recent" });
  expect(other.briefings).toHaveLength(2);

  const [plainRow] = await api.providers.db.select().from(sessionThreads).where(eq(sessionThreads.id, plain.id));
  expect(plainRow?.archivedAt).toBeTypeOf("number");
  const [waitingRow] = await api.providers.db.select().from(sessionThreads).where(eq(sessionThreads.id, waiting.id));
  expect(waitingRow?.archivedAt ?? null).toBeNull();
  const [unrelatedRow] = await api.providers.db.select().from(sessionThreads).where(eq(sessionThreads.id, unrelated.id));
  expect(unrelatedRow?.archivedAt ?? null).toBeNull();
  // A brief the server does not know is refused.
  expect((await fetch(`${api.baseUrl}/api/workspaces/user/briefings/brief:${"f".repeat(24)}/dismiss`, { method: "POST" })).status).toBe(404);

  expect((await fetch(`${api.baseUrl}/api/workspaces/user/briefings/not-a-brief/dismiss`, { method: "POST" })).status).toBe(400);
});
