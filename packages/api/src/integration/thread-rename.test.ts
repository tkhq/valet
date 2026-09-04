/** Tests thread renaming through PATCH /threads/:threadId. */
import { sql } from "drizzle-orm";
import { afterEach, describe, it, expect } from "vitest";
import { bootTestApi, type TestApi } from "./_setup.js";
import { setApprovedModels } from "../services/approved-models.js";
import { setOrgReasoningSettings } from "../services/reasoning.js";
import type {
  CreateSessionResponse,
  CreateThreadResponse,
  ListThreadsResponse,
  PatchThreadResponse,
} from "../wire/types.js";

async function createSession(baseUrl: string, headers?: Record<string, string>): Promise<string> {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ workspace: "/tmp" }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as CreateSessionResponse;
  return body.id;
}

async function createThread(baseUrl: string, sessionId: string, headers?: Record<string, string>): Promise<string> {
  const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as CreateThreadResponse;
  return body.id;
}

async function patchThread(
  baseUrl: string,
  sessionId: string,
  threadId: string,
  body: unknown,
  headers?: Record<string, string>,
) {
  return fetch(`${baseUrl}/api/sessions/${sessionId}/threads/${threadId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("api integration: thread rename", () => {
  let api: TestApi;

  afterEach(async () => {
    await api.cleanup();
  });
  it("renames a thread and returns the new title", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);
    const threadId = await createThread(api.baseUrl, sessionId);

    const res = await patchThread(api.baseUrl, sessionId, threadId, {
      title: "Postgres migration notes",
    });
    expect(res.status).toBe(200);
    const patched = (await res.json()) as PatchThreadResponse;
    expect(patched.id).toBe(threadId);
    expect(patched.title).toBe("Postgres migration notes");

    const list = (await (
      await fetch(`${api.baseUrl}/api/sessions/${sessionId}/threads`)
    ).json()) as ListThreadsResponse;
    const found = list.threads.find((t) => t.id === threadId);
    expect(found?.title).toBe("Postgres migration notes");
  }, 30_000);

  it("trims surrounding whitespace before storing", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);
    const threadId = await createThread(api.baseUrl, sessionId);

    const res = await patchThread(api.baseUrl, sessionId, threadId, {
      title: "   Spaced out   ",
    });
    expect(res.status).toBe(200);
    const patched = (await res.json()) as PatchThreadResponse;
    expect(patched.title).toBe("Spaced out");
  }, 30_000);

  it("clears the title when passed null", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);
    const threadId = await createThread(api.baseUrl, sessionId);

    const first = await patchThread(api.baseUrl, sessionId, threadId, { title: "Draft" });
    expect(first.status).toBe(200);

    const res = await patchThread(api.baseUrl, sessionId, threadId, { title: null });
    expect(res.status).toBe(200);
    const patched = (await res.json()) as PatchThreadResponse;
    expect(patched.title).toBeUndefined();
  }, 30_000);

  it("clears the title when passed an empty string", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);
    const threadId = await createThread(api.baseUrl, sessionId);

    const first = await patchThread(api.baseUrl, sessionId, threadId, { title: "Draft" });
    expect(first.status).toBe(200);

    const res = await patchThread(api.baseUrl, sessionId, threadId, { title: "   " });
    expect(res.status).toBe(200);
    const patched = (await res.json()) as PatchThreadResponse;
    expect(patched.title).toBeUndefined();
  }, 30_000);

  it("rejects a title past the length cap", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);
    const threadId = await createThread(api.baseUrl, sessionId);

    const res = await patchThread(api.baseUrl, sessionId, threadId, {
      title: "x".repeat(201),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("200 characters or fewer");
  }, 30_000);

  it("rejects a non-string, non-null title", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);
    const threadId = await createThread(api.baseUrl, sessionId);

    const res = await patchThread(api.baseUrl, sessionId, threadId, { title: 42 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Set title to a string, or use null to clear it.",
    });
  }, 30_000);

  it("creates a missing mirror row when renaming", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);
    const threadId = await createThread(api.baseUrl, sessionId);
    await api.providers.db.execute(
      sql`delete from session_threads where id = ${threadId}`,
    );

    const res = await patchThread(api.baseUrl, sessionId, threadId, { title: "Restored" });

    expect(res.status).toBe(200);
    expect((await res.json()) as PatchThreadResponse).toMatchObject({
      id: threadId,
      title: "Restored",
    });
  }, 30_000);

  it("creates a missing mirror row when archiving", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);
    const threadId = await createThread(api.baseUrl, sessionId);
    await api.providers.db.execute(
      sql`delete from session_threads where id = ${threadId}`,
    );

    const res = await patchThread(api.baseUrl, sessionId, threadId, { archived: true });
    const body = (await res.json()) as PatchThreadResponse;

    expect(res.status).toBe(200);
    expect(body.id).toBe(threadId);
    expect(typeof body.archivedAt).toBe("number");
    expect(body.title).toBeUndefined();
  }, 30_000);

  it("preserves archived_at when renaming", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);
    const threadId = await createThread(api.baseUrl, sessionId);

    const archRes = await patchThread(api.baseUrl, sessionId, threadId, { archived: true });
    expect(archRes.status).toBe(200);
    const archBody = (await archRes.json()) as PatchThreadResponse;
    expect(typeof archBody.archivedAt).toBe("number");

    const renameRes = await patchThread(api.baseUrl, sessionId, threadId, {
      title: "Named while archived",
    });
    expect(renameRes.status).toBe(200);
    const renameBody = (await renameRes.json()) as PatchThreadResponse;
    expect(renameBody.title).toBe("Named while archived");
    expect(typeof renameBody.archivedAt).toBe("number");
  }, 30_000);

  it("preserves the title when archiving", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);
    const threadId = await createThread(api.baseUrl, sessionId);

    const rename = await patchThread(api.baseUrl, sessionId, threadId, { title: "Kept" });
    expect(rename.status).toBe(200);

    const arch = await patchThread(api.baseUrl, sessionId, threadId, { archived: true });
    expect(arch.status).toBe(200);
    const body = (await arch.json()) as PatchThreadResponse;
    expect(body.title).toBe("Kept");
  }, 30_000);

  it("accepts title and model together in one PATCH", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);
    const threadId = await createThread(api.baseUrl, sessionId);

    const res = await patchThread(api.baseUrl, sessionId, threadId, {
      title: "Both fields",
      model: null,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PatchThreadResponse;
    expect(body.title).toBe("Both fields");
  }, 30_000);

  it("rejects a PATCH with none of model/archived/title", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);
    const threadId = await createThread(api.baseUrl, sessionId);

    const res = await patchThread(api.baseUrl, sessionId, threadId, {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("title");
  }, 30_000);

  it("accepts a reasoning-only PATCH (no model/archived/title required)", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);
    const threadId = await createThread(api.baseUrl, sessionId);

    const res = await patchThread(api.baseUrl, sessionId, threadId, { reasoning: "Medium" });
    expect(res.status).toBe(200);
  }, 30_000);

  it("400s a thread reasoning level exceeding the org cap", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);
    const threadId = await createThread(api.baseUrl, sessionId);
    await setOrgReasoningSettings(api.providers.db, "local-org", { max: "medium" });

    const res = await patchThread(api.baseUrl, sessionId, threadId, { reasoning: "high" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/exceeds the org max/);
  }, 30_000);

  it("400s an unknown thread reasoning level", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);
    const threadId = await createThread(api.baseUrl, sessionId);

    const res = await patchThread(api.baseUrl, sessionId, threadId, { reasoning: "not-a-level" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Unknown reasoning level/);
  }, 30_000);

  it("clears thread reasoning when passed null, even above the org cap", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);
    const threadId = await createThread(api.baseUrl, sessionId);
    await setOrgReasoningSettings(api.providers.db, "local-org", { max: "minimal" });

    const res = await patchThread(api.baseUrl, sessionId, threadId, { reasoning: null });
    expect(res.status).toBe(200);
  }, 30_000);

  it("400s a catalog-valid but unapproved thread model for a plain member", async () => {
    api = await bootTestApi();
    const MEMBER_HEADERS = { "x-valet-test-user-id": "test-member" };
    // A personal session has no org-admin bypass on view/administer (direct
    // owner only) — created as `test-member`, a real non-admin org member,
    // so `assertModelSelectable`'s admin flag is genuinely false here.
    const sessionId = await createSession(api.baseUrl, MEMBER_HEADERS);
    const threadId = await createThread(api.baseUrl, sessionId, MEMBER_HEADERS);
    await setApprovedModels(api.providers.db, "local-org", ["anthropic/claude-opus-4-7"]);

    const res = await patchThread(
      api.baseUrl,
      sessionId,
      threadId,
      { model: "anthropic/claude-haiku-4-5" },
      MEMBER_HEADERS,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/approved list/);
  }, 30_000);
});
