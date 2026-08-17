/**
 * The cursor stack a keyset pager keeps in the URL. Pure functions, so they
 * are tested here rather than through a component: what matters is that a
 * round trip through a search param gives back the same stack, because that
 * round trip is what makes Back page back.
 */
import { describe, expect, it } from "vitest";
import {
  currentCursor,
  formatCursorStack,
  pageNumber,
  parseCursorStack,
  popCursor,
  pushCursor,
} from "./cursor-stack";

describe("cursor stack", () => {
  it("reads an absent or empty param as the first page", () => {
    expect(parseCursorStack(undefined)).toEqual([]);
    expect(parseCursorStack("")).toEqual([]);
    expect(currentCursor([])).toBeUndefined();
    expect(pageNumber([])).toBe(1);
  });

  it("leaves the param off the URL on the first page", () => {
    expect(formatCursorStack([])).toBeUndefined();
  });

  it("survives a round trip through the URL", () => {
    // Cursors are base64url, which holds `-` and `_` but never `~`, so the
    // separator cannot split one cursor into two.
    const stack = ["eyJyIjoxfQ", "eyJyIjoyfQ-_"];
    const raw = formatCursorStack(stack);
    expect(raw).toBe("eyJyIjoxfQ~eyJyIjoyfQ-_");
    expect(parseCursorStack(raw)).toEqual(stack);
  });

  it("reads the page a stack names off its last entry", () => {
    expect(currentCursor(["a", "b"])).toBe("b");
    expect(pageNumber(["a", "b"])).toBe(3);
  });

  it("walks forward and back without losing the way home", () => {
    const first: string[] = [];
    const second = pushCursor(first, "a");
    const third = pushCursor(second, "b");

    expect(third).toEqual(["a", "b"]);
    expect(popCursor(third)).toEqual(["a"]);
    expect(popCursor(popCursor(third))).toEqual([]);
    // Page one has nowhere further back to go.
    expect(popCursor([])).toEqual([]);
  });

  it("drops empty entries from a hand-edited param", () => {
    expect(parseCursorStack("~a~~b~")).toEqual(["a", "b"]);
  });
});
