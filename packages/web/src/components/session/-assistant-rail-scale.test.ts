/**
 * The rail at scale. Measured against the running app with nine teams, the
 * Assistants block took 42% of the sidebar and had no scroll of its own, so
 * it squeezed the thread list rather than scrolling — twenty teams would
 * have left room for about two threads.
 *
 * A principal now owns any number of assistants, so the same column holds
 * more rows than teams. These pin the rules that keep it bounded without
 * introducing a worse fault.
 */
import { describe, expect, it } from "vitest";
import type { AssistantSummary, TeamSummary } from "@valet/api/wire";
import {
  assistantLabel,
  countAssistants,
  findAssistant,
  groupAssistants,
  ownDefaultAssistant,
  visibleGroups,
  type AssistantGroup,
} from "./assistant-rail";

function team(id: string, name = id, callerRole: "admin" | "member" | null = "member"): TeamSummary {
  return { id, orgId: "org_1", name, createdAt: 0, memberCount: 2, callerRole };
}

function own(id: string, over: Partial<AssistantSummary> = {}): AssistantSummary {
  return {
    id,
    owner: { type: "user", id: "u1" },
    sessionId: `assistant:${id}`,
    isDefault: false,
    createdAt: 0,
    ...over,
  };
}

function ownedBy(teamId: string, id: string, over: Partial<AssistantSummary> = {}): AssistantSummary {
  return { ...own(id, over), owner: { type: "team", id: teamId } };
}

/** One assistant per owner, nine owners — the shape the 42% measurement was
 * taken on. */
const NINE: AssistantGroup[] = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((id) => ({
  key: id,
  label: id,
  team: team(id),
  assistants: [ownedBy(id, id)],
}));

const sessionOf = (id: string) => `assistant:${id}`;

describe("visibleGroups", () => {
  it("shows every assistant when the list is short enough to fit", () => {
    const four = NINE.slice(0, 4);
    expect(countAssistants(visibleGroups(four, new Set()))).toBe(4);
  });

  it("caps a long list so assistants cannot push the thread list off screen", () => {
    expect(countAssistants(visibleGroups(NINE, new Set(), 5))).toBe(5);
  });

  it("never hides an assistant that is waiting on you, however far down it is", () => {
    // "i" is last of nine — well past the cap.
    const shown = visibleGroups(NINE, new Set([sessionOf("i")]), 5);
    expect(shown.map((g) => g.key)).toContain("i");
  });

  it("keeps the given order rather than pulling the waiting row to the top", () => {
    // Reordering on attention would move a row while the user reaches for
    // it — the same fault the thread list avoids by sorting on creation.
    const shown = visibleGroups(NINE, new Set([sessionOf("h")]), 5);
    expect(shown.map((g) => g.key)).toEqual(["a", "b", "c", "d", "e", "h"]);
  });

  it("brings back several waiting rows at once, still in order", () => {
    const waiting = new Set([sessionOf("i"), sessionOf("g")]);
    expect(visibleGroups(NINE, waiting, 5).map((g) => g.key)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "g",
      "i",
    ]);
  });

  it("ignores attention on a row already above the fold", () => {
    expect(countAssistants(visibleGroups(NINE, new Set([sessionOf("b")]), 5))).toBe(5);
  });

  /**
   * The cap counts rows, and the budget is spent one row per owner per pass.
   * A plain "first five rows" would let a prolific owner take the whole
   * budget and drop every other owner out of the sidebar.
   */
  it("gives every owner a share rather than letting the first owner take the budget", () => {
    const groups: AssistantGroup[] = [
      { key: "user", label: "Your assistants", assistants: ["a", "b", "c", "d", "e", "f"].map((id) => own(id)) },
      { key: "t1", label: "Platform", team: team("t1"), assistants: [ownedBy("t1", "p1"), ownedBy("t1", "p2")] },
    ];
    const shown = visibleGroups(groups, new Set(), 5);
    expect(shown.map((g) => g.assistants.map((a) => a.id))).toEqual([
      ["a", "b", "c"],
      ["p1", "p2"],
    ]);
  });

  it("never draws more owner headers than the row cap allows", () => {
    // One row per visible owner is the floor, so the cap bounds the headers
    // as well as the rows — the block cannot grow a header it has no row
    // for.
    expect(visibleGroups(NINE, new Set(), 5)).toHaveLength(5);
  });

  it("drops an owner whose rows are all hidden, header included", () => {
    const shown = visibleGroups(NINE, new Set(), 5);
    expect(shown.map((g) => g.key)).not.toContain("i");
  });
});

describe("groupAssistants", () => {
  const teams = [team("t1", "Platform"), team("t2", "Design")];

  it("puts your own assistants first, then each team in the given order", () => {
    const groups = groupAssistants(
      [ownedBy("t2", "d1"), own("mine"), ownedBy("t1", "p1")],
      teams,
    );
    expect(groups.map((g) => g.key)).toEqual(["user", "t1", "t2"]);
    expect(groups[0]?.label).toBe("Your assistants");
    expect(groups[1]?.label).toBe("Platform");
  });

  it("keeps every assistant a team owns, not just one", () => {
    const groups = groupAssistants(
      [ownedBy("t1", "p1"), ownedBy("t1", "p2"), ownedBy("t1", "p3")],
      teams,
    );
    expect(groups.map((g) => g.assistants.map((a) => a.id))).toEqual([["p1", "p2", "p3"]]);
  });

  it("drops assistants of a team the caller may not open", () => {
    // `eligibleTeams` has already removed the team, so its assistant has no
    // group to sit in — an org admin does not get a team's assistant in
    // their own sidebar just because they administer the org.
    expect(groupAssistants([ownedBy("t9", "x1")], teams)).toEqual([]);
  });

  it("drops org-owned assistants, which no route creates and no header names", () => {
    const orgOwned: AssistantSummary = { ...own("o1"), owner: { type: "org", id: "org_1" } };
    expect(groupAssistants([orgOwned], teams)).toEqual([]);
  });

  it("renders nothing while the list is unresolved", () => {
    expect(groupAssistants(undefined, teams)).toEqual([]);
  });

  it("omits a team that owns no assistant rather than heading an empty group", () => {
    expect(groupAssistants([own("mine")], teams).map((g) => g.key)).toEqual(["user"]);
  });
});

describe("findAssistant and ownDefaultAssistant", () => {
  const groups = groupAssistants(
    [own("mine"), own("second", { isDefault: true }), ownedBy("t1", "p1")],
    [team("t1", "Platform")],
  );

  it("finds an assistant the caller can reach", () => {
    expect(findAssistant(groups, "p1")?.id).toBe("p1");
  });

  it("returns nothing for an id the caller cannot reach", () => {
    expect(findAssistant(groups, "asst_nope")).toBeUndefined();
  });

  it("returns nothing when no assistant is named", () => {
    expect(findAssistant(groups, undefined)).toBeUndefined();
  });

  it("falls back to the default of your own assistants", () => {
    expect(ownDefaultAssistant(groups)?.id).toBe("second");
  });
});

describe("assistantLabel", () => {
  it("uses the name someone chose", () => {
    expect(assistantLabel(own("a", { name: "Aurora" }))).toBe("Aurora");
  });

  it("says an unnamed assistant is untitled rather than inventing a name", () => {
    expect(assistantLabel(own("a"))).toBe("Untitled assistant");
    expect(assistantLabel(own("a", { name: "  " }))).toBe("Untitled assistant");
  });

  it("names an unnamed default for what it is", () => {
    expect(assistantLabel(own("a", { isDefault: true }))).toBe("Default assistant");
  });
});
