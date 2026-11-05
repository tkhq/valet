import { describe, expect, it } from "vitest";
import { EXEC_ID_PATTERN, newExecId } from "../src/wakeups/ids.js";

describe("newExecId (fix wave 2, B1)", () => {
  it("returns job-<base36 ms>-<8 base36> with only [a-z0-9-]", () => {
    const before = Date.now();
    const id = newExecId();
    expect(id).toMatch(/^job-[0-9a-z]+-[0-9a-z]{8}$/);
    expect(id).toMatch(EXEC_ID_PATTERN);
    const ms = parseInt(id.split("-")[1] ?? "", 36);
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(Date.now());
  });

  it("never repeats, so a new sandbox handle cannot reuse a live job's files", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newExecId()));
    expect(ids.size).toBe(2000);
  });

  it("EXEC_ID_PATTERN accepts legacy counter ids and rejects path or shell text", () => {
    expect(EXEC_ID_PATTERN.test("job-3")).toBe(true);
    for (const bad of ["job-1.exit", "../job-1", "job-1/2", "job-1 ;rm", "JOB-1", "job-", "job-a--b", "", "job-1\n"]) {
      expect(EXEC_ID_PATTERN.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
