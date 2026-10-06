import { describe, expect, it } from "vitest";
import { mergePresence, readPresence, validatePresence } from "./presence.js";

describe("presence", () => {
  it("accepts partial identity and combines per-field defaults", () => {
    expect(readPresence({ displayName: "Release helper" })).toEqual({ displayName: "Release helper" });
    expect(mergePresence({ displayName: "Workflow", avatarUrl: "https://example.com/a.webp" }, { displayName: "Rule" })).toEqual({ displayName: "Rule", avatarUrl: "https://example.com/a.webp" });
    expect(mergePresence(undefined, {})).toBeUndefined();
  });
  it.each([null, [], "name", { displayName: " " }, { displayName: "a".repeat(81) }, { displayName: "hello\nworld" }, { avatarUrl: "http://example.com/a" }, { avatarUrl: "https://user:password@example.com/a" }, { avatarUrl: "data:image/png,a" }, { avatarUrl: "https://example.com/" + "a".repeat(2048) }, { typo: "name" }])("rejects invalid identity %j", (value) => {
    expect(validatePresence(value)).not.toBeNull();
    expect(readPresence(value)).toBeUndefined();
  });
});
