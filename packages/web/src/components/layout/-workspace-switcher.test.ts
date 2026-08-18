/**
 * The workspace switcher's two pure parts: what it offers, and which option
 * it shows as current.
 *
 * The active workspace is no longer derived here. It is held and persisted
 * by `workspace-scope.tsx`, because deriving it from the open assistant only
 * ever resolved on `/chat` and left every other surface reading "Personal".
 * The open assistant still wins where there is one, which keeps the property
 * this file used to hold on its own: the control cannot disagree with the
 * conversation on screen. `workspaceOfAssistant` and its tests moved with
 * it — see `~/lib/workspace-scope.test.ts`.
 */
import { describe, expect, it } from "vitest";
import type { AssistantSummary, TeamSummary } from "@valet/api/wire";
import { workspaceOptions } from "./workspace-switcher";

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

  it("falls back to the owner's first assistant when none is marked default", () => {
    // A workspace with assistants must never read as one with none —
    // selecting it from /chat would create a duplicate assistant.
    const options = workspaceOptions(
      [assistant("mine", ME, true), assistant("plat-a", { type: "team", id: "t1" })],
      [team("t1", "Platform")],
    );
    expect(options[1]?.defaultAssistantId).toBe("plat-a");
  });
});
