import { describe, expect, it } from "vitest";
import { parsePartialJson } from "./partial-json";

describe("parsePartialJson", () => {
  it("parses complete JSON", () => {
    expect(parsePartialJson('{"a": 1, "b": "x"}')).toEqual({ a: 1, b: "x" });
  });

  it("returns undefined for empty or whitespace input", () => {
    expect(parsePartialJson("")).toBeUndefined();
    expect(parsePartialJson("   ")).toBeUndefined();
  });

  it("completes a string truncated mid-value", () => {
    expect(parsePartialJson('{"path":"/tmp/x","content":"hel')).toEqual({
      path: "/tmp/x",
      content: "hel",
    });
  });

  it("drops a dangling key with no value yet", () => {
    expect(parsePartialJson('{"path":')).toEqual({});
    expect(parsePartialJson('{"path"')).toEqual({});
    expect(parsePartialJson('{"pa')).toEqual({});
  });

  it("tolerates a trailing comma", () => {
    expect(parsePartialJson('{"a":1,')).toEqual({ a: 1 });
  });

  it("closes nested structures", () => {
    expect(parsePartialJson('{"a":{"b":[1,2')).toEqual({ a: { b: [1, 2] } });
  });

  it("handles a truncated escape sequence", () => {
    expect(parsePartialJson('{"a":"x\\')).toEqual({ a: "x" });
    expect(parsePartialJson('{"a":"x\\u00')).toEqual({ a: "x" });
  });

  it("handles a truncated number and boolean literal", () => {
    expect(parsePartialJson('{"n": 12, "b": tr')).toEqual({ n: 12 });
  });

  it("returns undefined for non-JSON garbage", () => {
    expect(parsePartialJson("not json at all")).toBeUndefined();
  });
});
