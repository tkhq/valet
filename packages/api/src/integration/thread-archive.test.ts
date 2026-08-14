/**
 * Integration test: thread archive/unarchive via PATCH /threads/:threadId.
 *
 * Archive is app-side display state (`session_threads.archived_at`): an
 * archived thread leaves the default GET /threads list, appears under
 * `?archived=1`, and comes back on unarchive. The engine thread is
 * untouched — no Anthropic key needed, virtual sandbox only.
 */
import { describe, it, expect } from "vitest";
import { bootTestApi } from "./_setup.js";
import type {
  CreateSessionResponse,
  CreateThreadResponse,
  ListThreadsResponse,
  PatchThreadResponse,
} from "../wire/types.js";

describe("api integration: thread archive", () => {
  it("archives, lists, and unarchives a thread", async () => {
    const api = await bootTestApi();
    try {
      const createSession = await fetch(`${api.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace: "/tmp" }),
      });
      expect(createSession.status).toBe(201);
      const { id: sessionId } = (await createSession.json()) as CreateSessionResponse;

      const createThread = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/threads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(createThread.status).toBe(201);
      const thread = (await createThread.json()) as CreateThreadResponse;

      // Both threads (default + new) are listed before archiving.
      const before = (await (
        await fetch(`${api.baseUrl}/api/sessions/${sessionId}/threads`)
      ).json()) as ListThreadsResponse;
      expect(before.threads.map((t) => t.id)).toContain(thread.id);

      // Archive.
      const patch = await fetch(
        `${api.baseUrl}/api/sessions/${sessionId}/threads/${thread.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived: true }),
        },
      );
      expect(patch.status).toBe(200);
      const patched = (await patch.json()) as PatchThreadResponse;
      expect(patched.id).toBe(thread.id);
      expect(typeof patched.archivedAt).toBe("number");

      // Default list excludes the archived thread; the default thread stays.
      const after = (await (
        await fetch(`${api.baseUrl}/api/sessions/${sessionId}/threads`)
      ).json()) as ListThreadsResponse;
      expect(after.threads.map((t) => t.id)).not.toContain(thread.id);
      expect(after.threads.length).toBe(before.threads.length - 1);

      // ?archived=1 lists exactly the archived thread.
      const archivedList = (await (
        await fetch(`${api.baseUrl}/api/sessions/${sessionId}/threads?archived=1`)
      ).json()) as ListThreadsResponse;
      expect(archivedList.threads.map((t) => t.id)).toEqual([thread.id]);
      expect(typeof archivedList.threads[0]?.archivedAt).toBe("number");

      // Unarchive restores it to the default list.
      const unpatch = await fetch(
        `${api.baseUrl}/api/sessions/${sessionId}/threads/${thread.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived: false }),
        },
      );
      expect(unpatch.status).toBe(200);
      const unpatched = (await unpatch.json()) as PatchThreadResponse;
      expect(unpatched.archivedAt).toBeUndefined();

      const restored = (await (
        await fetch(`${api.baseUrl}/api/sessions/${sessionId}/threads`)
      ).json()) as ListThreadsResponse;
      expect(restored.threads.map((t) => t.id)).toContain(thread.id);
    } finally {
      await api.cleanup();
    }
  }, 30_000);

  it("rejects a PATCH with neither model nor archived", async () => {
    const api = await bootTestApi();
    try {
      const createSession = await fetch(`${api.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace: "/tmp" }),
      });
      const { id: sessionId } = (await createSession.json()) as CreateSessionResponse;
      const createThread = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/threads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const thread = (await createThread.json()) as CreateThreadResponse;

      const patch = await fetch(
        `${api.baseUrl}/api/sessions/${sessionId}/threads/${thread.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      expect(patch.status).toBe(400);
    } finally {
      await api.cleanup();
    }
  }, 30_000);
});
