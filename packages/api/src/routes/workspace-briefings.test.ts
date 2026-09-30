import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, sessionThreads } from "../schema/index.js";
import type { DismissWorkspaceBriefingResponse, WorkspaceBriefing, WorkspaceBriefingsResponse } from "../wire/types.js";

const briefs: WorkspaceBriefing[] = ["a", "b"].map((letter) => ({
  id: `brief:${letter.repeat(24)}`, title: `Brief ${letter}`, summary: "Summary.", status: "updated",
  updatedAt: 1, latestThread: null, sources: [],
}));
vi.mock("../services/workspace-briefings.js", () => ({
  getWorkspaceBriefings: async (): Promise<WorkspaceBriefingsResponse> => ({ briefings: briefs, generatedAt: 1, coverage: "recent" }),
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
  await api.providers.engineStore.saveDecisionGate(waiting.sessionId, waiting.id, {
    id: "gate-waiting", sessionId: waiting.sessionId, threadId: waiting.id, queueItemId: "q", resumeKey: "rk", ordinal: 0,
    type: "approval", title: "Approve?", actions: [{ id: "approve", label: "Approve" }], status: "pending", createdAt: 1, updatedAt: 1,
  });
  // Another person's session: never archived through this workspace.
  await api.providers.db.insert(agentSessions).values({ id: "someone-else", userId: "other", orgId: "local-org", workspace: "/",
    ownerType: "user", ownerId: "other", createdAt: 1, updatedAt: 1 });

  const dismiss = await fetch(`${api.baseUrl}/api/workspaces/user/briefings/${briefs[0]!.id}/dismiss`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threads: [
      { sessionId: plain.sessionId, threadId: plain.id },
      { sessionId: waiting.sessionId, threadId: waiting.id },
      { sessionId: "someone-else", threadId: "x" },
    ] }),
  });
  expect(dismiss.status).toBe(200);
  expect(await dismiss.json() as DismissWorkspaceBriefingResponse).toEqual({ dismissed: true, archived: 1, keptWaiting: 1 });

  const listed = await (await fetch(`${api.baseUrl}/api/workspaces/user/briefings`)).json() as WorkspaceBriefingsResponse;
  expect(listed.briefings.map((brief) => brief.id)).toEqual([briefs[1]!.id]);
  const [plainRow] = await api.providers.db.select().from(sessionThreads).where(eq(sessionThreads.id, plain.id));
  expect(plainRow?.archivedAt).toBeTypeOf("number");
  const [waitingRow] = await api.providers.db.select().from(sessionThreads).where(eq(sessionThreads.id, waiting.id));
  expect(waitingRow?.archivedAt ?? null).toBeNull();

  expect((await fetch(`${api.baseUrl}/api/workspaces/user/briefings/not-a-brief/dismiss`, { method: "POST" })).status).toBe(400);
});
