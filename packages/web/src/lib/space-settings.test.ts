import { describe, expect, it } from "vitest";
import { PERSONAL } from "~/lib/workspace-scope";
import { spaceSettingsHref, spaceSettingsTarget } from "./space-settings";

describe("spaceSettingsTarget", () => {
  it("opens Personal Integrations for your own space and a team's General tab for a team", () => {
    expect(spaceSettingsTarget(PERSONAL)).toEqual({ to: "/settings/integrations" });
    expect(spaceSettingsTarget("t1")).toEqual({ to: "/settings/teams/$teamId", params: { teamId: "t1" } });
  });

  it("names a tab in either space", () => {
    expect(spaceSettingsTarget(PERSONAL, "usage")).toEqual({ to: "/settings/usage" });
    expect(spaceSettingsTarget("t1", "integrations")).toEqual({ to: "/settings/teams/$teamId/integrations", params: { teamId: "t1" } });
  });
});

describe("spaceSettingsHref", () => {
  it("fills and encodes the team id", () => {
    expect(spaceSettingsHref("a b", "usage")).toBe("/settings/teams/a%20b/usage");
    expect(spaceSettingsHref(PERSONAL, "integrations")).toBe("/settings/integrations");
  });
});
