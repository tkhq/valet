// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useReportTimezoneOnce } from "./report-timezone";

const mutate = vi.fn();
vi.mock("~/api/settings", () => ({ usePatchMe: () => ({ mutate }) }));

afterEach(() => {
  mutate.mockReset();
  vi.restoreAllMocks();
});

function browserZone(zone: string) {
  const real = new Intl.DateTimeFormat().resolvedOptions();
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ ...real, timeZone: zone });
}

type Me = { timezone: string | null; timezoneReportDone: boolean };

describe("useReportTimezoneOnce", () => {
  it("reports the browser timezone once when none was ever set", () => {
    browserZone("America/Los_Angeles");
    const { rerender } = renderHook(({ me }) => useReportTimezoneOnce(me), {
      initialProps: { me: { timezone: null, timezoneReportDone: false } as Me | undefined },
    });
    rerender({ me: { timezone: null, timezoneReportDone: false } });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({ reportedTimezone: "America/Los_Angeles" });
  });

  it("never overrides a stored value", () => {
    browserZone("America/Los_Angeles");
    renderHook(() => useReportTimezoneOnce({ timezone: "Europe/Paris", timezoneReportDone: true }));
    expect(mutate).not.toHaveBeenCalled();
  });

  it("does not undo a clear: a cleared timezone with the done flag is not reported again", () => {
    browserZone("America/New_York");
    const { rerender } = renderHook(({ me }) => useReportTimezoneOnce(me), {
      initialProps: { me: { timezone: "Europe/Paris", timezoneReportDone: true } as Me | undefined },
    });
    rerender({ me: { timezone: null, timezoneReportDone: true } });
    expect(mutate).not.toHaveBeenCalled();
    // A fresh mount on a later page load behaves the same.
    renderHook(() => useReportTimezoneOnce({ timezone: null, timezoneReportDone: true }));
    expect(mutate).not.toHaveBeenCalled();
  });

  it("waits until the user has loaded", () => {
    browserZone("America/Los_Angeles");
    renderHook(() => useReportTimezoneOnce(undefined));
    expect(mutate).not.toHaveBeenCalled();
  });
});
