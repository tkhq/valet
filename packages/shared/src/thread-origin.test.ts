import { describe, expect, it } from "vitest";
import { parseThreadLineGroupKey, threadLineGroupKey, threadOrigin } from "./thread-origin.js";

describe("threadOrigin", () => {
  it.each([
    [undefined, "chat"], ["default", "chat"], ["web:abc", "chat"],
    ["events", "auto"], ["signal:workflow:run-1", "auto"],
    ["sub:r1:slack:C1:1.2", "auto"], ["sub:r1", "auto"], ["schedule:s1:1700000000000", "auto"], ["subject:github:acme/api#1", "auto"],
    ["slack:C1:1.2", "channel"], ["telegram:dm:1", "channel"],
    ["signal:agent-1", "other"], ["app-assistant:private", "other"],
  ])("reads %s as %s", (key, origin) => {
    expect(threadOrigin(key)).toBe(origin);
  });
});

describe("threadLineGroupKey", () => {
  it("groups a new-mode thread by its line", () => {
    expect(threadLineGroupKey("sub:r1:slack:C1:1712345678.000100")).toBe("sub:r1");
    expect(threadLineGroupKey("sub:r1:del-9")).toBe("sub:r1");
    expect(threadLineGroupKey("schedule:s1:1700000000000")).toBe("schedule:s1");
  });

  it("leaves a line's own thread and other keys ungrouped", () => {
    for (const key of ["sub:r1", "schedule:s1", "subject:github:acme/api#1", "slack:C1:1.2", "web:x", undefined]) {
      expect(threadLineGroupKey(key)).toBeUndefined();
    }
  });

  it("parses a group key back to the line", () => {
    expect(parseThreadLineGroupKey("sub:r1")).toEqual({ kind: "subscription", id: "r1" });
    expect(parseThreadLineGroupKey("schedule:s1")).toEqual({ kind: "schedule", id: "s1" });
    expect(parseThreadLineGroupKey("sub:r1:x")).toBeUndefined();
    expect(parseThreadLineGroupKey("web:x")).toBeUndefined();
  });
});
