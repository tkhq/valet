/**
 * GET /api/sessions — assistant-centered web UI decision 8: the list
 * excludes orchestrator ids and child ids server-side, seeded here directly
 * (no engine turns needed) — a standalone row, an orchestrator row, and a
 * child row, asserting only the standalone one comes back.
 */
import { describe, it, expect } from "vitest";
import { bootTestApi } from "./_setup.js";
import { assistantSessionId } from "@valet/engine";
import { agentSessions, childWatches } from "../schema/index.js";
import type { ListSessionsResponse } from "../wire/types.js";

describe("GET /api/sessions: standalone-only filter", () => {
  it("excludes every assistant row and child rows, keeps standalone rows", async () => {
    const api = await bootTestApi();
    try {
      const { db } = api.providers;
      const now = Date.now();
      const defaultAssistantId = assistantSessionId("asst_default");
      const secondAssistantId = assistantSessionId("asst_second");

      await db
        .insert(agentSessions)
        .values([
          {
            id: "standalone-1",
            userId: "local-user",
            orgId: "local-org",
            workspace: "/tmp/standalone-1",
            title: "Standalone session",
            status: "active",
            ownerType: "user",
            ownerId: "local-user",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: defaultAssistantId,
            userId: "local-user",
            orgId: "local-org",
            workspace: "/tmp/assistant-default",
            title: "Assistant",
            status: "active",
            ownerType: "user",
            ownerId: "local-user",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: secondAssistantId,
            userId: "local-user",
            orgId: "local-org",
            workspace: "/tmp/assistant-second",
            title: "Research",
            status: "active",
            ownerType: "user",
            ownerId: "local-user",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "child-1",
            userId: "local-user",
            orgId: "local-org",
            workspace: "/tmp/child-1",
            title: "Delegated work",
            status: "active",
            ownerType: "user",
            ownerId: "local-user",
            createdAt: now,
            updatedAt: now,
          },
        ]);

      await db
        .insert(childWatches)
        .values({
          childSessionId: "child-1",
          queueItemId: "qi-1",
          parentSessionId: defaultAssistantId,
          parentThreadId: "th-1",
          actorUserId: "local-user",
          orgId: "local-org",
          settled: false,
          createdAt: now,
        });

      const res = await fetch(`${api.baseUrl}/api/sessions`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ListSessionsResponse;

      expect(body.sessions.map((s) => s.id)).toEqual(["standalone-1"]);
    } finally {
      await api.cleanup();
    }
  });
});
