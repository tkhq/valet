import { describe, expect, it } from "vitest";
import { parseCommandArgs, substituteArgs } from "../src/commands/args.js";

describe("parseCommandArgs", () => {
  it("splits on whitespace", () => expect(parseCommandArgs("a b  c")).toEqual(["a", "b", "c"]));
  it("respects double quotes", () => expect(parseCommandArgs('a "b c" d')).toEqual(["a", "b c", "d"]));
  it("respects single quotes", () => expect(parseCommandArgs("x 'y z'")).toEqual(["x", "y z"]));
  it("handles empty input", () => expect(parseCommandArgs("")).toEqual([]));
});

describe("substituteArgs", () => {
  it("replaces positional args", () => expect(substituteArgs("fix $1 in $2", ["bug", "auth"])).toBe("fix bug in auth"));
  it("missing positional becomes empty", () => expect(substituteArgs("$1/$2", ["a"])).toBe("a/"));
  it("replaces $@ and $ARGUMENTS", () => {
    expect(substituteArgs("all: $@", ["a", "b"])).toBe("all: a b");
    expect(substituteArgs("all: $ARGUMENTS", ["a", "b"])).toBe("all: a b");
  });
  it("slices ${@:N} and ${@:N:L}", () => {
    expect(substituteArgs("${@:2}", ["a", "b", "c"])).toBe("b c");
    expect(substituteArgs("${@:1:2}", ["a", "b", "c"])).toBe("a b");
  });
  it("does not re-substitute arg values", () =>
    expect(substituteArgs("$1", ["$2"])).toBe("$2"));
});
