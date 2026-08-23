import { describe, expect, it } from "vitest";
import { textParam } from "./search-params";

describe("textParam", () => {
  it("reads a string value", () => {
    expect(textParam({ q: "slack" }, "q")).toBe("slack");
  });

  it("reads a missing key as absent", () => {
    expect(textParam({}, "q")).toBeUndefined();
  });

  it("reads a hand-edited non-string value as absent, not a crash", () => {
    expect(textParam({ q: 3 }, "q")).toBeUndefined();
    expect(textParam({ q: ["a"] }, "q")).toBeUndefined();
    expect(textParam({ q: null }, "q")).toBeUndefined();
  });

  it("reads a non-object search as absent", () => {
    expect(textParam(undefined, "q")).toBeUndefined();
    expect(textParam("q=x", "q")).toBeUndefined();
    expect(textParam(null, "q")).toBeUndefined();
  });
});
