/**
 * Pure unit tests for provider.ts's death-detection primitives — no
 * cluster needed. `execId` format (Task 4 carry-forward: THIS task owns
 * execId generation and must assert its format can't traverse
 * `/tmp/valet-jobs/` — no slashes, no dots) and the signal-killed exit-code
 * heuristic mirrored from sandbox-docker's `looksSignalKilled`.
 */
import { describe, expect, it } from "vitest";
import { assertSafeExecId, looksSignalKilled } from "../src/provider.js";

describe("looksSignalKilled", () => {
  it("flags the 129-192 signal-shaped exit-code band", () => {
    expect(looksSignalKilled(129)).toBe(true); // SIGHUP
    expect(looksSignalKilled(137)).toBe(true); // SIGKILL
    expect(looksSignalKilled(143)).toBe(true); // SIGTERM
    expect(looksSignalKilled(192)).toBe(true); // 128+64, upper bound
  });

  it("does not flag ordinary exit codes", () => {
    expect(looksSignalKilled(0)).toBe(false);
    expect(looksSignalKilled(1)).toBe(false);
    expect(looksSignalKilled(2)).toBe(false);
    expect(looksSignalKilled(127)).toBe(false);
    expect(looksSignalKilled(128)).toBe(false); // boundary: exclusive
  });

  it("does not flag codes above the signal band", () => {
    expect(looksSignalKilled(193)).toBe(false);
    expect(looksSignalKilled(255)).toBe(false);
  });
});

describe("assertSafeExecId", () => {
  it("accepts the provider's own generated format", () => {
    expect(() => assertSafeExecId("job-1")).not.toThrow();
    expect(() => assertSafeExecId("job-42")).not.toThrow();
    expect(() => assertSafeExecId("job-999999")).not.toThrow();
  });

  it("rejects ids containing a path separator (no /tmp traversal)", () => {
    expect(() => assertSafeExecId("job-1/../../etc/passwd")).toThrow();
    expect(() => assertSafeExecId("../job-1")).toThrow();
    expect(() => assertSafeExecId("job-1/2")).toThrow();
  });

  it("rejects ids containing a dot", () => {
    expect(() => assertSafeExecId("job-1.exit")).toThrow();
    expect(() => assertSafeExecId("job-1.")).toThrow();
    expect(() => assertSafeExecId("..")).toThrow();
  });

  it("rejects ids with whitespace or shell metacharacters", () => {
    expect(() => assertSafeExecId("job-1 ; rm -rf /")).toThrow();
    expect(() => assertSafeExecId("job-1\n")).toThrow();
    expect(() => assertSafeExecId("job-1$(whoami)")).toThrow();
  });

  it("rejects an empty id", () => {
    expect(() => assertSafeExecId("")).toThrow();
  });
});
