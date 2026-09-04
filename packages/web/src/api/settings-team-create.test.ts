import { describe, expect, it } from "vitest";
import { qkAssistants } from "./assistants";
import { qkSettings, teamCreateQueryKeys } from "./settings";

describe("teamCreateQueryKeys", () => {
  it("invalidates teams and the bare assistants prefix", () => {
    // `createTeam` writes the team's default assistant in the same
    // transaction. The assistants key is the prefix (`["assistants"]`) so
    // every workspace's cache entry refreshes, same convention as
    // `qk.sessions()`.
    expect(teamCreateQueryKeys()).toEqual([qkSettings.teams(), qkAssistants.list()]);
    expect(qkAssistants.list()).toEqual(["assistants"]);
  });
});
