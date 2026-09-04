import { describe, expect, it } from "vitest";
import type { AssistantSummary, TeamSummary } from "@valet/api/wire";
import { PERSONAL } from "~/lib/workspace-scope";
import { chooseChatAssistant, groupAssistants, scopedDefaultAssistant } from "./assistant-rail";

function team(id: string, name = id): TeamSummary {
  return {
    id,
    orgId: "org_1",
    name,
    origin: "local",
    externalId: null,
    createdAt: 0,
    memberCount: 2,
    callerRole: "member",
  };
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

const teams = [team("t1", "Platform"), team("t2", "Design")];

describe("scopedDefaultAssistant", () => {
  const groups = groupAssistants(
    [own("mine", { isDefault: true }), ownedBy("t1", "p1"), ownedBy("t1", "p2", { isDefault: true })],
    teams,
  );

  it("returns the team's default", () => {
    expect(scopedDefaultAssistant(groups, "t1")?.id).toBe("p2");
  });

  it("returns the first assistant when the team has no default", () => {
    const noDefault = groupAssistants([ownedBy("t1", "p1"), ownedBy("t1", "p2")], [team("t1")]);
    expect(scopedDefaultAssistant(noDefault, "t1")?.id).toBe("p1");
  });

  it("returns nothing for a team that owns no assistant", () => {
    const empty = groupAssistants([own("mine")], teams);
    expect(scopedDefaultAssistant(empty, "t1")).toBeUndefined();
  });

  it("returns your own default when the scope is personal", () => {
    expect(scopedDefaultAssistant(groups, PERSONAL)?.id).toBe("mine");
  });
});

describe("chooseChatAssistant", () => {
  const groups = groupAssistants(
    [
      own("mine", { isDefault: true }),
      ownedBy("t1", "p1"),
      ownedBy("t1", "p2", { isDefault: true }),
    ],
    teams,
  );

  it("opens a named assistant the caller can reach", () => {
    expect(chooseChatAssistant(groups, "t1", "p1")).toEqual({
      kind: "open",
      assistant: expect.objectContaining({ id: "p1" }),
      canonicalize: false,
    });
  });

  it("opens the team's default and asks to canonicalize when none is named", () => {
    expect(chooseChatAssistant(groups, "t1", undefined)).toEqual({
      kind: "open",
      assistant: expect.objectContaining({ id: "p2" }),
      canonicalize: true,
    });
  });

  it("opens the team's first assistant when it has no default", () => {
    const noDefault = groupAssistants([own("mine"), ownedBy("t1", "p1")], [team("t1")]);
    expect(chooseChatAssistant(noDefault, "t1", undefined)).toEqual({
      kind: "open",
      assistant: expect.objectContaining({ id: "p1" }),
      canonicalize: true,
    });
  });

  it("opens your own default without rewriting the URL", () => {
    expect(chooseChatAssistant(groups, PERSONAL, undefined)).toEqual({
      kind: "open",
      assistant: expect.objectContaining({ id: "mine" }),
      canonicalize: false,
    });
  });

  it("keeps the personal GET /info fallback when the list has no own assistant", () => {
    expect(chooseChatAssistant([], PERSONAL, undefined)).toEqual({
      kind: "personal",
      assistant: undefined,
    });
  });

  it("falls back to your own default when the named assistant is unreachable", () => {
    expect(chooseChatAssistant(groups, "t1", "asst_nope")).toEqual({
      kind: "personal",
      assistant: expect.objectContaining({ id: "mine" }),
    });
  });

  it("reports an empty team instead of opening a personal conversation", () => {
    const emptyTeam = groupAssistants([own("mine", { isDefault: true })], teams);
    const choice = chooseChatAssistant(emptyTeam, "t1", undefined);
    expect(choice).toEqual({ kind: "empty-team" });
    expect(choice).not.toMatchObject({ kind: "personal" });
    expect(choice).not.toMatchObject({ kind: "open" });
  });
});
