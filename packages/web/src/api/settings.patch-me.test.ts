import { describe, expect, it } from "vitest";
import type { MeResponse } from "@valet/api/wire";
import { mergePatchMe, revertPatchMe, sameStringList } from "./settings";

const me: MeResponse = {
  id: "u1",
  email: "me@example.com",
  name: "Ada",
  avatarUrl: null,
  role: "member",
  orgId: "org_1",
  orgRole: "admin",
  defaultModel: null,
  modelPreferences: [],
};

describe("mergePatchMe / revertPatchMe", () => {
  it("merges a preference list into the cached me payload", () => {
    const next = mergePatchMe(me, { modelPreferences: ["claude-haiku-4-5"] });
    expect(next.modelPreferences).toEqual(["claude-haiku-4-5"]);
    expect(next.name).toBe("Ada");
  });

  it("does not revert preferences when a later optimistic list already replaced them", () => {
    const afterFirst = mergePatchMe(me, { modelPreferences: ["claude-haiku-4-5"] });
    const afterSecond = mergePatchMe(afterFirst, {
      modelPreferences: ["claude-haiku-4-5", "claude-sonnet-4-5"],
    });
    const reverted = revertPatchMe(afterSecond, afterFirst, {
      modelPreferences: ["claude-haiku-4-5"],
    });
    expect(reverted.modelPreferences).toEqual(["claude-haiku-4-5", "claude-sonnet-4-5"]);
  });

  it("reverts only the defaultModel field when a later prefs write is in the cache", () => {
    const afterPrefs = mergePatchMe(me, { modelPreferences: ["claude-haiku-4-5"] });
    const afterDefault = mergePatchMe(afterPrefs, { defaultModel: "claude-sonnet-4-5" });
    const reverted = revertPatchMe(afterDefault, afterPrefs, { defaultModel: "claude-sonnet-4-5" });
    expect(reverted.defaultModel).toBeNull();
    expect(reverted.modelPreferences).toEqual(["claude-haiku-4-5"]);
  });

  it("sameStringList is order-sensitive", () => {
    expect(sameStringList(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameStringList(["a", "b"], ["b", "a"])).toBe(false);
  });
});
