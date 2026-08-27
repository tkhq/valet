import { describe, expect, it } from "vitest";
import { safeNextPath } from "./next-path";

describe("safeNextPath", () => {
  it("accepts same-origin relative paths, with query strings", () => {
    expect(safeNextPath("/a/tok123")).toBe("/a/tok123");
    expect(safeNextPath("/memory/people/alice.md")).toBe("/memory/people/alice.md");
    expect(safeNextPath("/sessions?filter=running")).toBe("/sessions?filter=running");
  });

  it("rejects absolute and scheme-relative URLs — the open-redirect shapes", () => {
    expect(safeNextPath("https://evil.example/a/x")).toBeUndefined();
    expect(safeNextPath("//evil.example/a/x")).toBeUndefined();
    // Browsers normalize backslashes: "/\evil.example" navigates off-origin.
    expect(safeNextPath("/\\evil.example")).toBeUndefined();
    expect(safeNextPath("javascript:alert(1)")).toBeUndefined();
  });

  it("rejects non-strings and empty values", () => {
    expect(safeNextPath(undefined)).toBeUndefined();
    expect(safeNextPath(42)).toBeUndefined();
    expect(safeNextPath("")).toBeUndefined();
    expect(safeNextPath("relative/path")).toBeUndefined();
  });

  it("rejects the auth pages themselves — a next of /login is a loop", () => {
    expect(safeNextPath("/login")).toBeUndefined();
    expect(safeNextPath("/login?next=%2Fa%2Fx")).toBeUndefined();
    expect(safeNextPath("/signup")).toBeUndefined();
    // But paths that merely START with the strings are fine.
    expect(safeNextPath("/loginish")).toBe("/loginish");
  });
});
