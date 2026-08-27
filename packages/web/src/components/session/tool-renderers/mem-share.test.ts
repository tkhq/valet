import { describe, expect, it } from "vitest";
import { parseShareResult } from "./mem-share";

describe("parseShareResult", () => {
  it("extracts the URL and audience from the tool's share line", () => {
    const text =
      "shared artifacts/report.md → https://valet.example/a/tok123\n" +
      "Audience: Logged-in members of the user's org. The user can widen or revoke this link from the memory page.";
    expect(parseShareResult(text)).toEqual({
      url: "https://valet.example/a/tok123",
      audience:
        "Logged-in members of the user's org. The user can widen or revoke this link from the memory page.",
    });
  });

  it("tolerates a missing audience line", () => {
    expect(parseShareResult("shared a.md → https://valet.example/a/t")).toEqual({
      url: "https://valet.example/a/t",
      audience: null,
    });
  });

  it("returns null for revoke confirmations and errors", () => {
    expect(parseShareResult("revoked share for artifacts/report.md")).toBeNull();
    expect(parseShareResult("[memory_error] share succeeded but returned no URL")).toBeNull();
    expect(parseShareResult("")).toBeNull();
  });
});
