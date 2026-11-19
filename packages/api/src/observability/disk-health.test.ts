import { describe, expect, it } from "vitest";
import { DiskAlertState, resolveDiskAlertBytes } from "./disk-health.js";

const GB = 1024 ** 3;
const MIN = 60_000;

describe("DiskAlertState", () => {
  it("reports on the first low sample, repeats every 30 minutes, and reports recovery once", () => {
    const state = new DiskAlertState(15 * GB);
    expect(state.next(80 * GB, 0)).toBe("none");
    expect(state.next(14 * GB, 1 * MIN)).toBe("report");
    expect(state.next(13 * GB, 2 * MIN)).toBe("none");
    expect(state.next(12 * GB, 30 * MIN)).toBe("none");
    expect(state.next(12 * GB, 31 * MIN)).toBe("report");
    expect(state.next(20 * GB, 32 * MIN)).toBe("recovered");
    expect(state.next(20 * GB, 33 * MIN)).toBe("none");
  });

  it("reports a new drop at once, even soon after the last report", () => {
    const state = new DiskAlertState(15 * GB);
    expect(state.next(10 * GB, 0)).toBe("report");
    expect(state.next(20 * GB, 1 * MIN)).toBe("recovered");
    expect(state.next(10 * GB, 2 * MIN)).toBe("report");
  });
});

describe("resolveDiskAlertBytes", () => {
  it("reads gigabytes and keeps an unset or empty value off", () => {
    expect(resolveDiskAlertBytes({ VALET_DISK_ALERT_FREE_GB: " 15 " })).toBe(15 * GB);
    expect(resolveDiskAlertBytes({})).toBeUndefined();
    expect(resolveDiskAlertBytes({ VALET_DISK_ALERT_FREE_GB: "" })).toBeUndefined();
  });

  it.each(["0", "-1", "lots"])("rejects %j with corrective guidance", (raw) => {
    expect(() => resolveDiskAlertBytes({ VALET_DISK_ALERT_FREE_GB: raw })).toThrow(/VALET_DISK_ALERT_FREE_GB.*Set it/);
  });
});
