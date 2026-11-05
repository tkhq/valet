import { describe, expect, it } from "vitest";
import { mergeAppearance, readAppearance, validateAppearance } from "./appearance.js";

describe("appearance", () => {
  it("accepts partial identity and combines per-field defaults", () => {
    expect(readAppearance({ displayName: "Release helper" })).toEqual({ displayName: "Release helper" });
    expect(mergeAppearance({ displayName: "Workflow", avatarUrl: "https://example.com/a.webp" }, { displayName: "Rule" })).toEqual({ displayName: "Rule", avatarUrl: "https://example.com/a.webp" });
    expect(mergeAppearance(undefined, {})).toBeUndefined();
    expect(readAppearance({})).toBeUndefined();
    expect(readAppearance({ displayName: undefined, avatarUrl: undefined })).toBeUndefined();
  });
  it.each([null, [], "name", { displayName: " " }, { displayName: "a".repeat(81) }, { displayName: "hello\nworld" }, { avatarUrl: "http://example.com/a" }, { avatarUrl: "https://user:password@example.com/a" }, { avatarUrl: "data:image/png,a" }, { avatarUrl: "https://example.com/" + "a".repeat(2048) }, { typo: "name" }])("rejects invalid identity %j", (value) => {
    expect(validateAppearance(value)).not.toBeNull();
    expect(readAppearance(value)).toBeUndefined();
  });
});
