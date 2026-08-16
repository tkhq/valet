/**
 * GET /api/sessions — the `runState` and `lastActivityAt` fields of
 * `SessionSummary`. Rows are seeded directly (no engine turn needed) to cover
 * the states that come from the row itself, and the query-count test pins the
 * rule the list depends on: one cross-session submission read, never one read
 * per session.
 *
 * The queue-driven states are covered elsewhere: `working` end to end in
 * `routes/sessions.create.test.ts` (via `initialPrompt`), and the full
 * precedence order in `sessions/run-state.test.ts`.
 */
import { describe, it, expect, vi } from "vitest";
import { bootTestApi } from "./_setup.js";
import { agentSessions } from "../schema/index.js";
import type { ListSessionsResponse } from "../wire/types.js";

function sessionRow(id: string, status: "active" | "hibernated", updatedAt: number) {
  return {
    id,
    userId: "local-user",
    orgId: "local-org",
    workspace: `/tmp/${id}`,
    title: id,
    status,
    ownerType: "user",
    ownerId: "local-user",
    createdAt: updatedAt - 5_000,
    updatedAt,
  };
}

describe("GET /api/sessions: run state", () => {
  it("reads idle for an active row and sleeping for a hibernated one", async () => {
    const api = await bootTestApi();
    try {
      const { db } = api.providers;
      const now = Date.now();
      await db
        .insert(agentSessions)
        .values([sessionRow("awake-1", "active", now), sessionRow("asleep-1", "hibernated", now - 60_000)]);

      const res = await fetch(`${api.baseUrl}/api/sessions`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ListSessionsResponse;

      const awake = body.sessions.find((s) => s.id === "awake-1");
      const asleep = body.sessions.find((s) => s.id === "asleep-1");
      expect(awake?.runState).toBe("idle");
      expect(asleep?.runState).toBe("sleeping");
      // With no queue activity, the row's own timestamp is the last activity.
      expect(awake?.lastActivityAt).toBe(now);
      expect(asleep?.lastActivityAt).toBe(now - 60_000);
    } finally {
      await api.cleanup();
    }
  });

  it("reads every session's submissions in one query, whatever the number of sessions", async () => {
    const api = await bootTestApi();
    try {
      const { db, engineStore } = api.providers;
      const now = Date.now();
      await db
        .insert(agentSessions)
        .values([
          sessionRow("many-1", "active", now),
          sessionRow("many-2", "active", now),
          sessionRow("many-3", "active", now),
        ]);

      const all = vi.spyOn(engineStore, "listAllUnsettledSubmissions");
      const perSession = vi.spyOn(engineStore, "listUnsettledSubmissions");
      try {
        const res = await fetch(`${api.baseUrl}/api/sessions`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as ListSessionsResponse;
        expect(body.sessions.length).toBeGreaterThanOrEqual(3);

        // Asserted before `mockRestore`, which clears the call record.
        expect(all).toHaveBeenCalledTimes(1);
        expect(perSession).not.toHaveBeenCalled();
      } finally {
        all.mockRestore();
        perSession.mockRestore();
      }
    } finally {
      await api.cleanup();
    }
  });
});
