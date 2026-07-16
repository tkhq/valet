/**
 * Pure unit tests for files.ts's command builders and output parsers — no
 * cluster required.
 */
import { describe, expect, it } from "vitest";
import {
  mkdirCommand,
  parseReaddirOutput,
  parseStatOutput,
  readBinaryCommand,
  readdirCommand,
  rmCommand,
  statCommand,
  writeBinaryCommand,
} from "../src/files.js";
import { shQuote } from "../src/exec.js";

describe("command builders quote paths", () => {
  it.each([
    ["readBinaryCommand", readBinaryCommand],
    ["writeBinaryCommand", writeBinaryCommand],
    ["readdirCommand", readdirCommand],
    ["mkdirCommand", mkdirCommand],
  ] as const)("%s embeds a shell-quoted path", (_name, fn) => {
    const path = "a dir/with 'quotes'.txt";
    expect(fn(path)).toContain(shQuote(path));
  });

  it("rmCommand uses -rf when recursive, -f otherwise", () => {
    expect(rmCommand("p", true)).toBe(`rm -rf ${shQuote("p")}`);
    expect(rmCommand("p", false)).toBe(`rm -f ${shQuote("p")}`);
  });

  it("statCommand embeds the path twice (both branches of the probe)", () => {
    const path = "weird path";
    const cmd = statCommand(path);
    expect(cmd.split(shQuote(path)).length - 1).toBeGreaterThanOrEqual(2);
  });
});

describe("parseStatOutput", () => {
  it("parses a directory probe", () => {
    expect(parseStatOutput("d 0\n")).toEqual({ isFile: false, isDirectory: true, size: 0 });
  });

  it("parses a file probe with size", () => {
    expect(parseStatOutput("f 12345\n")).toEqual({ isFile: true, isDirectory: false, size: 12345 });
  });

  it("throws on unrecognized output", () => {
    expect(() => parseStatOutput("garbage")).toThrow();
  });
});

describe("parseReaddirOutput", () => {
  it("splits newline-separated entries", () => {
    expect(parseReaddirOutput("a.txt\nb.txt\n")).toEqual(["a.txt", "b.txt"]);
  });

  it("returns [] for empty stdout (empty directory)", () => {
    expect(parseReaddirOutput("")).toEqual([]);
  });

  it("does not produce a trailing empty-string entry", () => {
    expect(parseReaddirOutput("only.txt\n")).toEqual(["only.txt"]);
  });

  it("preserves entries with spaces", () => {
    expect(parseReaddirOutput("a file.txt\nanother one.txt\n")).toEqual(["a file.txt", "another one.txt"]);
  });
});
