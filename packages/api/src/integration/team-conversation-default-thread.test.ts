import { afterEach, expect, it } from "vitest";
import type { WireEvent } from "../wire/types.js";
import { bootTestApi, type TestApi } from "./_setup.js";
import { createTeam } from "../services/teams.js";

let api: TestApi;
afterEach(async () => { await api?.cleanup(); });

async function connectOnce(wsUrl: string, sessionId: string): Promise<void> {
  const ws = new WebSocket(`${wsUrl}/api/sessions/${sessionId}/ws`);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { ws.close(); reject(new Error("no queue.state frame")); }, 5_000);
    ws.onmessage = (event) => {
      const frame = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString()) as WireEvent;
      if (frame.type !== "queue.state") return;
      clearTimeout(timeout);
      ws.close();
      resolve();
    };
    ws.onerror = () => { clearTimeout(timeout); reject(new Error("ws error")); };
  });
}

it("opening a team conversation adds no empty default thread beside it", async () => {
  api = await bootTestApi();
  const team = await createTeam(api.providers.db, { orgId: "local-org", name: "One thread", creatorUserId: "local-user" });
  const response = await fetch(`${api.baseUrl}/api/threads?workspace=${team.id}`, { method: "POST" });
  expect(response.status).toBe(201);
  const created = await response.json() as { id: string; sessionId: string };

  await connectOnce(api.wsUrl, created.sessionId);
  expect((await fetch(`${api.baseUrl}/api/threads/${created.id}/messages`)).status).toBe(200);
  // An attachment download opens the session too; this thread has none.
  expect((await fetch(`${api.baseUrl}/api/sessions/${created.sessionId}/threads/${created.id}/files?path=missing.txt`)).status).toBe(404);

  const execution = api.providers.engineHost.liveSession(created.sessionId);
  expect(execution?.listThreads().map(thread => thread.id)).toEqual([created.id]);
  const listed = await (await fetch(`${api.baseUrl}/api/threads?workspace=${team.id}`)).json() as { threads: Array<{ id: string }> };
  expect(listed.threads.map(thread => thread.id)).toEqual([created.id]);
});
