import { describe, expect, it } from "vitest";
import { scheduledRunId, scheduleRunPrefix } from "./schedule-run-id.js";

// Review S5: two proposal routines share the `proposal-` start of their ids,
// so the prefix hashes the whole id.
describe("scheduleRunPrefix", () => {
  it("gives two proposal routines distinct prefixes", () => {
    expect(scheduleRunPrefix("proposal-aaa")).not.toBe(scheduleRunPrefix("proposal-bbb"));
    expect(scheduleRunPrefix("wfsched_mv1abc")).not.toBe(scheduleRunPrefix("wfsched_mv1abd"));
  });

  it("is stable and pinned to one example the api and the web both assert", () => {
    expect(scheduleRunPrefix("proposal-aaa")).toBe("wfrun_sch_1a2834f7313832_");
    expect(scheduledRunId("proposal-aaa", 1000)).toBe("wfrun_sch_1a2834f7313832_1000");
    expect(scheduledRunId("0a1b2c3d-4e5f-6789-abcd-ef0123456789", 1000)).toMatch(/^wfrun_sch_[0-9a-f]{14}_1000$/);
  });
});
