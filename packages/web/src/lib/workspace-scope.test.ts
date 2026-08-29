/**
 * `workspaceOfAssistant` — the pure half of the workspace scope.
 *
 * These cases moved here from the switcher's test when the scope stopped
 * being derived state and became held state. The function survives because
 * the open assistant still WINS over the stored key: that is what stops the
 * nav from claiming one workspace while the conversation on screen belongs
 * to another.
 *
 * It returns `undefined` rather than "Personal" when nothing is open, which
 * is the whole reason the stored key exists. Its predecessor answered
 * "Personal" here, and that answer was wrong on every route without an
 * `?assistant=` — `/skills`, `/workflows` and `/events` all read as personal
 * no matter which workspace the reader was in.
 */
import { describe, expect, it } from "vitest";
import type { AssistantSummary } from "@valet/api/wire";
import {
  PERSONAL,
  resolveWorkspaceKey,
  workspaceKeyForOwner,
  workspaceOfAssistant,
} from "./workspace-scope";

const ME = { type: "user", id: "u1" } as const;

function assistant(
  id: string,
  owner: AssistantSummary["owner"],
  isDefault = false,
): AssistantSummary {
  return { id, owner, sessionId: `assistant:${id}`, isDefault, createdAt: 0 };
}

describe("workspaceOfAssistant", () => {
  it("reads the workspace off the open assistant's owner", () => {
    expect(workspaceOfAssistant(assistant("p", { type: "team", id: "t1" }))).toBe("t1");
  });

  it("treats one of your own assistants as Personal, default or not", () => {
    expect(workspaceOfAssistant(assistant("mine", ME))).toBe(PERSONAL);
    expect(workspaceOfAssistant(assistant("mine", ME, true))).toBe(PERSONAL);
  });

  it("answers undefined when nothing is open, so the stored key decides", () => {
    // Not `PERSONAL`. Returning a workspace here would override the stored
    // scope on every route that has no assistant in the URL — which is every
    // route except /chat — and pin them all to Personal.
    expect(workspaceOfAssistant(undefined)).toBeUndefined();
  });
});

/**
 * The interesting case is a race, so the resolution is a pure function.
 *
 * The provider derives `available` from TWO queries — teams and org. While
 * either is loading, `available` holds the caller's own workspace alone.
 * Reading that as "the stored team is gone" drops a valid scope, and the
 * provider then persists the drop to localStorage, so the workspace is lost
 * for good rather than for a frame.
 */
describe("resolveWorkspaceKey", () => {
  const TEAM = "team_1";

  it("keeps a stored team while membership is still loading", () => {
    // Exactly the race: the org query answered, the teams query has not, so
    // `available` is Personal-only and says nothing about team_1 yet.
    expect(
      resolveWorkspaceKey({
        derived: undefined,
        stored: TEAM,
        available: [PERSONAL],
        membershipKnown: false,
      }),
    ).toBe(TEAM);
  });

  it("keeps a stored team once membership confirms it", () => {
    expect(
      resolveWorkspaceKey({
        derived: undefined,
        stored: TEAM,
        available: [PERSONAL, TEAM],
        membershipKnown: true,
      }),
    ).toBe(TEAM);
  });

  it("drops a team the caller has actually left", () => {
    expect(
      resolveWorkspaceKey({
        derived: undefined,
        stored: TEAM,
        available: [PERSONAL],
        membershipKnown: true,
      }),
    ).toBe(PERSONAL);
  });

  it("lets the open assistant win over the stored key", () => {
    expect(
      resolveWorkspaceKey({
        derived: "team_2",
        stored: TEAM,
        available: [PERSONAL, TEAM],
        membershipKnown: true,
      }),
    ).toBe("team_2");
  });

  it("lets the open assistant win before membership is known", () => {
    // Arriving on a team conversation from a notification must move the
    // scope immediately, not after two queries settle.
    expect(
      resolveWorkspaceKey({
        derived: "team_2",
        stored: PERSONAL,
        available: [PERSONAL],
        membershipKnown: false,
      }),
    ).toBe("team_2");
  });
});

describe("workspaceKeyForOwner (deep-link scope adoption)", () => {
  it("maps a team-owned resource to that team's key", () => {
    expect(workspaceKeyForOwner({ type: "team", id: "team_9" })).toBe("team_9");
  });

  it("maps a user-owned resource to the personal workspace", () => {
    expect(workspaceKeyForOwner({ type: "user", id: "u1" })).toBe(PERSONAL);
  });

  it("maps an org-owned resource to the personal workspace (no switcher scope for org)", () => {
    expect(workspaceKeyForOwner({ type: "org", id: "org1" })).toBe(PERSONAL);
  });

  it("is undefined while the owner is unknown, so adoption waits for the data", () => {
    expect(workspaceKeyForOwner(undefined)).toBeUndefined();
  });
});
