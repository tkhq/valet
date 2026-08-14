/**
 * The workspace switcher's two pure parts: what it offers, and which option
 * it shows as current.
 *
 * The rule worth stating once, because both functions exist to hold it: the
 * active workspace is DERIVED from the open assistant, never stored beside
 * it. A second copy could disagree with the conversation on screen, and a
 * link arriving from a notification or a shared URL would land the reader in
 * one workspace while the control claimed another.
 */
import { describe, expect, it } from "vitest";
import type { AssistantSummary, TeamSummary } from "@valet/api/wire";
import { activeWorkspaceKey, workspaceOptions } from "./workspace-switcher";

function team(id: string, name = id): TeamSummary {
  return { id, orgId: "org_1", name, createdAt: 0, memberCount: 2, callerRole: "member" };
}

function assistant(
  id: string,
  owner: AssistantSummary["owner"],
  isDefault = false,
): AssistantSummary {
  return { id, owner, sessionId: `assistant:${id}`, isDefault, createdAt: 0 };
}

const ME = { type: "user", id: "u1" } as const;

describe("workspaceOptions", () => {
  it("puts Personal first, then each team in the order given", () => {
    const options = workspaceOptions(
      [assistant("a1", ME, true), assistant("t1a", { type: "team", id: "t1" }, true)],
      [team("t1", "Platform"), team("t2", "Design")],
    );
    expect(options.map((o) => o.label)).toEqual(["Personal", "Platform", "Design"]);
    expect(options[0]?.isTeam).toBe(false);
  });

  it("targets each workspace's default assistant", () => {
    const options = workspaceOptions(
      [
        assistant("mine", ME, true),
        assistant("other", ME),
        assistant("plat", { type: "team", id: "t1" }, true),
      ],
      [team("t1", "Platform")],
    );
    expect(options[0]?.defaultAssistantId).toBe("mine");
    expect(options[1]?.defaultAssistantId).toBe("plat");
  });

  it("still lists a team that owns no assistant, but leaves it unselectable", () => {
    // Hiding it would make a team you belong to absent from the one control
    // whose job is to enumerate where you can work — the reader would
    // conclude they had been removed from the team.
    const options = workspaceOptions([assistant("mine", ME, true)], [team("t1", "Platform")]);
    expect(options.map((o) => o.label)).toEqual(["Personal", "Platform"]);
    expect(options[1]?.defaultAssistantId).toBeUndefined();
  });

  it("offers Personal alone before the assistants list resolves", () => {
    expect(workspaceOptions(undefined, []).map((o) => o.label)).toEqual(["Personal"]);
  });
});

describe("activeWorkspaceKey", () => {
  it("reads the workspace off the open assistant's owner", () => {
    expect(activeWorkspaceKey(assistant("p", { type: "team", id: "t1" }))).toBe("t1");
  });

  it("treats one of your own assistants as Personal, default or not", () => {
    expect(activeWorkspaceKey(assistant("mine", ME))).toBe("user");
    expect(activeWorkspaceKey(assistant("mine", ME, true))).toBe("user");
  });

  it("falls back to Personal when nothing is open", () => {
    // A bare /chat is your own workspace. Nothing is persisted, so returning
    // tomorrow cannot silently leave you in a team you last visited.
    expect(activeWorkspaceKey(undefined)).toBe("user");
  });
});
