import { describe, expect, it } from "vitest";
import { parseGlobalFlags } from "./output.js";

describe("cli/output parseGlobalFlags", () => {
  it("recognizes --json as a boolean and sets json", () => {
    const p = parseGlobalFlags(["--json"]);
    expect(p.json).toBe(true);
    expect(p.flags.json).toBe(true);
    expect(p.rest).toEqual([]);
  });

  it("parses --key=value", () => {
    const p = parseGlobalFlags(["--instance=prod"]);
    expect(p.flags.instance).toBe("prod");
    expect(p.json).toBe(false);
  });

  it("parses --key value (consuming the next token)", () => {
    const p = parseGlobalFlags(["--instance", "prod", "sess-1"]);
    expect(p.flags.instance).toBe("prod");
    expect(p.rest).toEqual(["sess-1"]);
  });

  it("treats a trailing --flag as boolean", () => {
    const p = parseGlobalFlags(["--verbose"]);
    expect(p.flags.verbose).toBe(true);
  });

  it("treats --flag followed by another flag as boolean", () => {
    const p = parseGlobalFlags(["--verbose", "--json"]);
    expect(p.flags.verbose).toBe(true);
    expect(p.flags.json).toBe(true);
    expect(p.json).toBe(true);
  });

  it("accumulates positionals into rest", () => {
    const p = parseGlobalFlags(["send", "sess-1", "--instance", "prod", "hello"]);
    expect(p.rest).toEqual(["send", "sess-1", "hello"]);
    expect(p.flags.instance).toBe("prod");
  });

  it("handles an empty arg list", () => {
    const p = parseGlobalFlags([]);
    expect(p).toEqual({ json: false, rest: [], flags: {} });
  });
});
