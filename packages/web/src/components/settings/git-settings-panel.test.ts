import { describe, expect, it } from "vitest";
import { controlsFromGitMode, gitModeFromControls, gitSettingsPatch } from "./git-settings-panel";

describe("Git settings mode conversion", () => {
  it("uses one reversible conversion for all UI combinations", () => {
    for (const identity of ["user", "valet"] as const) for (const signed of [false, true]) {
      expect(controlsFromGitMode(gitModeFromControls(identity, signed))).toEqual({ identity, signed });
    }
  });

  it("patches each changed field without materializing inherited values", () => {
    expect(gitSettingsPatch("mode", "valet_unsigned")).toEqual({ mode: "valet_unsigned" });
    expect(gitSettingsPatch("coAuthoredBy", true)).toEqual({ coAuthoredBy: true });
    expect(gitSettingsPatch("correlationTrailers", false)).toEqual({ correlationTrailers: false });
  });
});
