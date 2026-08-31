/**
 * Integration test: thread rename via PATCH /threads/:threadId.
 *
 * Rename writes `session_threads.title` (the app-side mirror the sidebar
 * reads). The engine thread is untouched — no Anthropic key needed,
 * virtual sandbox only. Port of v1 manual thread renaming, adapted to the
 * v2 wire shape.
 */
import { describe, it, expect } from "vitest";
import { bootTestApi } from "./_setup.js";
import type {
  CreateSessionResponse,
  CreateThreadResponse,
  ListThreadsResponse,
  PatchThreadResponse,
} from "../wire/types.js";

async function createSession(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace: "/tmp" }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as CreateSessionResponse;
  return body.id;
}

async function createThread(baseUrl: string, sessionId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as CreateThreadResponse;
  return body.id;
}

async function patchThread(baseUrl: string, sessionId: string, threadId: string, body: unknown) {
  return fetch(`${baseUrl}/api/sessions/${sessionId}/threads/${threadId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("api integration: thread rename", () => {
  it("renames a thread and returns the new title", async () => {
    const api = await bootTestApi();
    try {
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
    } finally {
      await api.cleanup();
    }
  }, 30_000);

  it("trims surrounding whitespace before storing", async () => {
    const api = await bootTestApi();
    try {
      const sessionId = await createSession(api.baseUrl);
      const threadId = await createThread(api.baseUrl, sessionId);

      const res = await patchThread(api.baseUrl, sessionId, threadId, {
        title: "   Spaced out   ",
      });
      expect(res.status).toBe(200);
      const patched = (await res.json()) as PatchThreadResponse;
      expect(patched.title).toBe("Spaced out");
    } finally {
      await api.cleanup();
    }
  }, 30_000);

  it("clears the title when passed null", async () => {
    const api = await bootTestApi();
    try {
      const sessionId = await createSession(api.baseUrl);
      const threadId = await createThread(api.baseUrl, sessionId);

      // Set a title first so the clear has something to clear.
      const first = await patchThread(api.baseUrl, sessionId, threadId, { title: "Draft" });
      expect(first.status).toBe(200);

      const res = await patchThread(api.baseUrl, sessionId, threadId, { title: null });
      expect(res.status).toBe(200);
      const patched = (await res.json()) as PatchThreadResponse;
      expect(patched.title).toBeUndefined();
    } finally {
      await api.cleanup();
    }
  }, 30_000);

  it("clears the title when passed an empty string", async () => {
    const api = await bootTestApi();
    try {
      const sessionId = await createSession(api.baseUrl);
      const threadId = await createThread(api.baseUrl, sessionId);

      const first = await patchThread(api.baseUrl, sessionId, threadId, { title: "Draft" });
      expect(first.status).toBe(200);

      const res = await patchThread(api.baseUrl, sessionId, threadId, { title: "   " });
      expect(res.status).toBe(200);
      const patched = (await res.json()) as PatchThreadResponse;
      expect(patched.title).toBeUndefined();
    } finally {
      await api.cleanup();
    }
  }, 30_000);

  it("rejects a title past the length cap", async () => {
    const api = await bootTestApi();
    try {
      const sessionId = await createSession(api.baseUrl);
      const threadId = await createThread(api.baseUrl, sessionId);

      const res = await patchThread(api.baseUrl, sessionId, threadId, {
        title: "x".repeat(201),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("200 characters or fewer");
    } finally {
      await api.cleanup();
    }
  }, 30_000);

  it("rejects a non-string, non-null title", async () => {
    const api = await bootTestApi();
    try {
      const sessionId = await createSession(api.baseUrl);
      const threadId = await createThread(api.baseUrl, sessionId);

      const res = await patchThread(api.baseUrl, sessionId, threadId, { title: 42 });
      expect(res.status).toBe(400);
    } finally {
      await api.cleanup();
    }
  }, 30_000);

  it("preserves archived_at when renaming", async () => {
    const api = await bootTestApi();
    try {
      const sessionId = await createSession(api.baseUrl);
      const threadId = await createThread(api.baseUrl, sessionId);

      // Archive first, then rename — the archive flag must survive.
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
    } finally {
      await api.cleanup();
    }
  }, 30_000);

  it("preserves the title when archiving", async () => {
    const api = await bootTestApi();
    try {
      const sessionId = await createSession(api.baseUrl);
      const threadId = await createThread(api.baseUrl, sessionId);

      // Rename first, then archive — the title must survive.
      const rename = await patchThread(api.baseUrl, sessionId, threadId, { title: "Kept" });
      expect(rename.status).toBe(200);

      const arch = await patchThread(api.baseUrl, sessionId, threadId, { archived: true });
      expect(arch.status).toBe(200);
      const body = (await arch.json()) as PatchThreadResponse;
      expect(body.title).toBe("Kept");
    } finally {
      await api.cleanup();
    }
  }, 30_000);

  it("accepts title and model together in one PATCH", async () => {
    const api = await bootTestApi();
    try {
      const sessionId = await createSession(api.baseUrl);
      const threadId = await createThread(api.baseUrl, sessionId);

      const res = await patchThread(api.baseUrl, sessionId, threadId, {
        title: "Both fields",
        model: null,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as PatchThreadResponse;
      expect(body.title).toBe("Both fields");
    } finally {
      await api.cleanup();
    }
  }, 30_000);

  it("rejects a PATCH with none of model/archived/title", async () => {
    const api = await bootTestApi();
    try {
      const sessionId = await createSession(api.baseUrl);
      const threadId = await createThread(api.baseUrl, sessionId);

      const res = await patchThread(api.baseUrl, sessionId, threadId, {});
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("title");
    } finally {
      await api.cleanup();
    }
  }, 30_000);
});
