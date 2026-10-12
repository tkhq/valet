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

describe("useReportTimezoneOnce", () => {
  it("reports the browser timezone once when none is stored", () => {
    browserZone("America/Los_Angeles");
    const { rerender } = renderHook(({ me }) => useReportTimezoneOnce(me), {
      initialProps: { me: { timezone: null } as { timezone: string | null } | undefined },
    });
    rerender({ me: { timezone: null } });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({ timezone: "America/Los_Angeles" });
  });

  it("never overrides a stored value", () => {
    browserZone("America/Los_Angeles");
    renderHook(() => useReportTimezoneOnce({ timezone: "Europe/Paris" }));
    expect(mutate).not.toHaveBeenCalled();
  });

  it("waits until the user has loaded", () => {
    browserZone("America/Los_Angeles");
    renderHook(() => useReportTimezoneOnce(undefined));
    expect(mutate).not.toHaveBeenCalled();
  });
});
