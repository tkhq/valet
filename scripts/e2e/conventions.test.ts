import { describe, expect, it } from "vitest";
import {
  DOUBLE_CAST_ALLOWLIST,
  checkBannedPatterns,
  checkWsTypes,
  renderViolations,
  type PackageManifest,
  type SourceFile,
} from "./conventions.js";

const src = (path: string, content: string): SourceFile => ({ path, content });

describe("checkBannedPatterns", () => {
  it("flags @ts-ignore and @ts-expect-error with line numbers", () => {
    const v = checkBannedPatterns([
      src("packages/api/src/a.ts", 'const x = 1;\n// @ts-ignore\nconst y: string = 1;\n'),
    ]);
    // The suppressor itself sits on a comment line — it must still be caught.
    expect(v).toHaveLength(1);
    expect(v[0].line).toBe(2);
    expect(v[0].message).toContain("banned");
  });

  it("catches @ts-expect-error on a code line", () => {
    const v = checkBannedPatterns([
      src("packages/api/src/a.ts", 'foo(); /* @ts-expect-error */ bar();\n'),
    ]);
    expect(v).toHaveLength(1);
  });

  it("flags a new as-unknown-as double-cast in a non-allowlisted file", () => {
    const v = checkBannedPatterns([
      src("packages/api/src/new.ts", "const x = y as unknown as string;\n"),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("allowlist permits 0");
  });

  it("permits allowlisted files up to their baseline count", () => {
    const path = "packages/api/src/providers/blob-fs.ts";
    expect(DOUBLE_CAST_ALLOWLIST[path]).toBe(1);
    const one = checkBannedPatterns([src(path, "a as unknown as B;\n")]);
    expect(one).toHaveLength(0);
    const two = checkBannedPatterns([src(path, "a as unknown as B;\nc as unknown as D;\n")]);
    expect(two).toHaveLength(1);
    expect(two[0].message).toContain("allowlist permits 1");
  });

  it("ignores banned patterns in prose comments", () => {
    const v = checkBannedPatterns([
      src(
        "packages/api/src/doc.ts",
        "// never write `as unknown as` casts\n * docs mention @ts-expect-error here\nconst ok = 1;\n",
      ),
    ]);
    expect(v).toHaveLength(0);
  });
});

describe("checkWsTypes", () => {
  const manifest = (path: string, deps: Record<string, string>, dev: Record<string, string>): PackageManifest => ({
    path,
    json: { dependencies: deps, devDependencies: dev },
  });

  it("passes a ws consumer declaring both @types packages", () => {
    const v = checkWsTypes([
      manifest("packages/a/package.json", { ws: "^8" }, { "@types/ws": "^8", "@types/node": "^22" }),
    ]);
    expect(v).toHaveLength(0);
  });

  it("flags a ws consumer missing @types/node (the recurring bug)", () => {
    const v = checkWsTypes([
      manifest("packages/a/package.json", { ws: "^8" }, { "@types/ws": "^8" }),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("@types/node");
  });

  it("flags a ws consumer missing both", () => {
    const v = checkWsTypes([manifest("packages/a/package.json", { ws: "^8" }, {})]);
    expect(v).toHaveLength(2);
  });

  it("ignores packages without ws", () => {
    const v = checkWsTypes([manifest("packages/a/package.json", {}, { "@types/ws": "^8" })]);
    expect(v).toHaveLength(0);
  });
});

describe("renderViolations", () => {
  it("renders clean state", () => {
    expect(renderViolations([])).toBe("conventions: clean");
  });

  it("renders path:line for line violations and bare path for file-level ones", () => {
    const out = renderViolations([
      { path: "a.ts", line: 3, message: "m1" },
      { path: "b/package.json", line: 0, message: "m2" },
    ]);
    expect(out).toContain("a.ts:3");
    expect(out).toContain("b/package.json  m2");
    expect(out).toContain("2 convention violation(s)");
  });
});
