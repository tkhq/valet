/**
 * TKAI-584: a thread snapshots the user's timezone when it is created, so a
 * later change never alters that thread's prompt. New threads pick up the
 * current value. Ordinary, assistant, and child builds all supply it.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { THREAD_USER_TIMEZONE_KEY } from "@valet/engine";
import { agentSessions } from "../schema/index.js";
import { defaultAssistantSessionFor } from "../test-helpers/assistant-session.js";
import type { CreateSessionResponse } from "../wire/types.js";
import { bootTestApi, type TestApi } from "./_setup.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

async function setTimezone(baseUrl: string, timezone: string | null) {
  const res = await fetch(`${baseUrl}/api/me`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ timezone }),
  });
  expect(res.status).toBe(200);
}

it("gives an ordinary session the user timezone, and keeps each thread's value after a change and a rebuild", async () => {
  api = await bootTestApi();
  const { baseUrl } = api;
  const { engineHost, engineStore } = api.providers;
  const workspace = await mkdtemp(join(tmpdir(), "valet-thread-tz-"));
  await setTimezone(baseUrl, "America/Los_Angeles");

  const created = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace }),
  });
  expect(created.status).toBe(201);
  const { id } = await created.json() as CreateSessionResponse;
  const meta = { orgId: "local-org", userId: "local-user", workspace };

  const session = await engineHost.sessionFor(id, meta);
  expect(session.options.userTimezone).toBe("America/Los_Angeles");
  const first = await session.ensureDefaultThread();
  expect((await engineStore.getThread(id, first.id))?.metadata?.[THREAD_USER_TIMEZONE_KEY]).toBe("America/Los_Angeles");

  // The user changes the timezone, then the session is evicted and rebuilt.
  await setTimezone(baseUrl, "Asia/Tokyo");
  engineHost.evictCache(id);
  const rebuilt = await engineHost.sessionFor(id, meta);
  expect(rebuilt.options.userTimezone).toBe("Asia/Tokyo");
  const same = await rebuilt.ensureDefaultThread();
  expect(same.id).toBe(first.id);
  expect((await engineStore.getThread(id, first.id))?.metadata?.[THREAD_USER_TIMEZONE_KEY]).toBe("America/Los_Angeles");

  // A new thread picks up the current value, even in the already-running session.
  await setTimezone(baseUrl, "Europe/Paris");
  const next = await rebuilt.createThread("web:second");
  expect((await engineStore.getThread(id, next.id))?.metadata?.[THREAD_USER_TIMEZONE_KEY]).toBe("Europe/Paris");
  expect((await engineStore.getThread(id, first.id))?.metadata?.[THREAD_USER_TIMEZONE_KEY]).toBe("America/Los_Angeles");
});

it("stamps null when the user has no timezone", async () => {
  api = await bootTestApi();
  const { engineHost, engineStore } = api.providers;
  const workspace = await mkdtemp(join(tmpdir(), "valet-thread-tz-"));
  const created = await fetch(`${api.baseUrl}/api/sessions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace }),
  });
  const { id } = await created.json() as CreateSessionResponse;
  const session = await engineHost.sessionFor(id, { orgId: "local-org", userId: "local-user", workspace });
  const thread = await session.ensureDefaultThread();
  expect((await engineStore.getThread(id, thread.id))?.metadata?.[THREAD_USER_TIMEZONE_KEY]).toBeNull();
});

it("keeps an evicted and rebuilt child's thread timezone", async () => {
  api = await bootTestApi();
  const { baseUrl } = api;
  const p = api.providers;
  await setTimezone(baseUrl, "America/Los_Angeles");
  const parent = await defaultAssistantSessionFor({ db: p.db, engineHost: p.engineHost }, { type: "user", id: "local-user" }, { actorUserId: "local-user", orgId: "local-org" });
  const parentThread = parent.thread("web:child-parent");
  const childId = `child-tz-${randomUUID()}`;
  const workspace = "/tmp/child-tz";
  await p.db.insert(agentSessions).values({
    id: childId, userId: "local-user", orgId: "local-org", workspace,
    ownerType: "user", ownerId: "local-user", createdAt: Date.now(), updatedAt: Date.now(),
  });
  const child = await p.engineHost.childSessionFor(childId, {
    parentSessionId: parent.id, parentThreadId: parentThread.id,
    actorUserId: "local-user", orgId: "local-org", owner: parent.owner, workspace,
  });
  const thread = await child.ensureDefaultThread();
  expect((await p.engineStore.getThread(childId, thread.id))?.metadata?.[THREAD_USER_TIMEZONE_KEY]).toBe("America/Los_Angeles");

  await setTimezone(baseUrl, "Asia/Tokyo");
  p.engineHost.evictCache(childId);
  const rebuilt = await p.engineHost.sessionFor(childId, { orgId: "local-org", userId: "local-user", workspace });
  const again = await rebuilt.ensureDefaultThread();
  expect(again.id).toBe(thread.id);
  expect((await p.engineStore.getThread(childId, thread.id))?.metadata?.[THREAD_USER_TIMEZONE_KEY]).toBe("America/Los_Angeles");
});
