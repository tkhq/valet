/**
 * The rail at scale. Measured against the running app with nine teams, the
 * Assistants block took 42% of the sidebar and had no scroll of its own, so
 * it squeezed the thread list rather than scrolling — twenty teams would
 * have left room for about two threads.
 *
 * These pin the two rules that fix it without introducing a worse one.
 */
import { describe, expect, it } from "vitest";
import type { TeamSummary } from "@valet/api/wire";
import { visibleTeams } from "./assistant-rail";
import { teamOrchestratorSessionId } from "~/lib/orchestrator-id";

function team(id: string, name = id): TeamSummary {
  return { id, orgId: "org_1", name, createdAt: 0, memberCount: 2, callerRole: "member" };
}

const NINE = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((id) => team(id));

describe("visibleTeams", () => {
  it("shows every team when the list is short enough to fit", () => {
    const four = NINE.slice(0, 4);
    expect(visibleTeams(four, new Set())).toHaveLength(4);
  });

  it("caps a long list so teams cannot push the thread list off screen", () => {
    expect(visibleTeams(NINE, new Set(), 5)).toHaveLength(5);
  });

  it("never hides a team that is waiting on you, however far down it is", () => {
    // "i" is last of nine — well past the cap.
    const waiting = new Set([teamOrchestratorSessionId("i")]);
    const shown = visibleTeams(NINE, waiting, 5);
    expect(shown.map((t) => t.id)).toContain("i");
  });

  it("keeps the given order rather than pulling the waiting team to the top", () => {
    // Reordering on attention would move a row while the user reaches for
    // it — the same fault the thread list avoids by sorting on creation.
    const waiting = new Set([teamOrchestratorSessionId("h")]);
    const shown = visibleTeams(NINE, waiting, 5).map((t) => t.id);
    expect(shown).toEqual(["a", "b", "c", "d", "e", "h"]);
  });

  it("brings back several waiting teams at once, still in order", () => {
    const waiting = new Set([
      teamOrchestratorSessionId("i"),
      teamOrchestratorSessionId("g"),
    ]);
    expect(visibleTeams(NINE, waiting, 5).map((t) => t.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "g",
      "i",
    ]);
  });

  it("ignores attention on a team already above the fold", () => {
    const waiting = new Set([teamOrchestratorSessionId("b")]);
    expect(visibleTeams(NINE, waiting, 5)).toHaveLength(5);
  });
});
