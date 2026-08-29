import { describe, expect, it } from "vitest";
import { findingFingerprint } from "./fingerprint.js";

describe("findingFingerprint", () => {
  it("is deterministic and 16 hex characters", () => {
    const input = { file: "src/auth.ts", line: 42, title: "JWT signature not verified" };
    const a = findingFingerprint(input);
    const b = findingFingerprint({ ...input });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("normalizes the title: case and whitespace do not change the print", () => {
    const base = findingFingerprint({ file: "a.ts", line: 5, title: "SQL injection in query" });
    expect(findingFingerprint({ file: "a.ts", line: 5, title: "  SQL   Injection\tin query " })).toBe(
      base,
    );
    expect(findingFingerprint({ file: "a.ts", line: 5, title: "sql injection IN QUERY" })).toBe(base);
  });

  it("buckets lines by tens: 11 and 19 collide, 9 and 11 do not", () => {
    const at11 = findingFingerprint({ file: "a.ts", line: 11, title: "t" });
    const at19 = findingFingerprint({ file: "a.ts", line: 19, title: "t" });
    const at9 = findingFingerprint({ file: "a.ts", line: 9, title: "t" });
    expect(at11).toBe(at19);
    expect(at9).not.toBe(at11);
  });

  it("distinguishes files and treats null/undefined file and line alike", () => {
    const withFile = findingFingerprint({ file: "a.ts", line: 1, title: "t" });
    const otherFile = findingFingerprint({ file: "b.ts", line: 1, title: "t" });
    expect(withFile).not.toBe(otherFile);

    const noFileNull = findingFingerprint({ file: null, line: null, title: "t" });
    const noFileUndef = findingFingerprint({ title: "t" });
    expect(noFileNull).toBe(noFileUndef);
    expect(noFileNull).not.toBe(withFile);
  });
});
