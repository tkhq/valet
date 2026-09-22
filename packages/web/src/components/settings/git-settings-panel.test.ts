import { describe, expect, it } from "vitest";
import { controlsFromGitMode, gitModeFromControls } from "./git-settings-panel";

describe("Git settings mode conversion", () => {
  it("uses one reversible conversion for all UI combinations", () => {
    for (const identity of ["user", "valet"] as const) for (const signed of [false, true]) {
      expect(controlsFromGitMode(gitModeFromControls(identity, signed))).toEqual({ identity, signed });
    }
  });
});
