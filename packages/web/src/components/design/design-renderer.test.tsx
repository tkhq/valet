// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHealthPostGate,
  DesignRenderer,
  HEALTH_HEARTBEAT_MS,
  healthReportKey,
  isSectionHidden,
  type DesignRenderHealth,
} from "./design-renderer";

const health = (over: Partial<DesignRenderHealth> = {}): DesignRenderHealth => ({
  totalSlides: 3,
  hiddenSlides: [],
  overflowingSlides: [],
  sparseSlides: [],
  scriptsStripped: 0,
  ...over,
});

describe("healthReportKey", () => {
  it("is stable for equal measurements of the same revision", () => {
    expect(healthReportKey("r1", health())).toBe(healthReportKey("r1", health()));
  });

  it("differs when the measured verdict differs", () => {
    expect(healthReportKey("r1", health())).not.toBe(
      healthReportKey("r1", health({ hiddenSlides: [1, 2] })),
    );
    expect(healthReportKey("r1", health())).not.toBe(
      healthReportKey("r1", health({ overflowingSlides: [0] })),
    );
  });

  it("differs across revisions", () => {
    expect(healthReportKey("r1", health())).not.toBe(healthReportKey("r2", health()));
  });
});

describe("createHealthPostGate", () => {
  it("admits the first post, blocks an identical repeat inside the window", () => {
    const gate = createHealthPostGate(60_000);
    expect(gate("k1", 1_000)).toBe(true);
    expect(gate("k1", 2_000)).toBe(false);
  });

  it("admits the same key again after the window elapses (heartbeat)", () => {
    const gate = createHealthPostGate(60_000);
    expect(gate("k1", 1_000)).toBe(true);
    expect(gate("k1", 61_001)).toBe(true);
    expect(gate("k1", 61_002)).toBe(false);
  });

  it("admits a changed key immediately (contradicting measurement)", () => {
    const gate = createHealthPostGate(60_000);
    expect(gate("k1", 1_000)).toBe(true);
    expect(gate("k2", 1_001)).toBe(true);
    expect(gate("k1", 1_002)).toBe(true);
  });
});

describe("isSectionHidden", () => {
  const visible = {
    display: "block",
    visibility: "visible",
    opacity: "1",
    heightPx: 500,
    hasLiveAnimation: false,
  };

  it("reports a plainly visible section as not hidden", () => {
    expect(isSectionHidden(visible)).toBe(false);
  });

  it("flags opacity 0 with no animation, but not mid-animation", () => {
    expect(isSectionHidden({ ...visible, opacity: "0" })).toBe(true);
    expect(isSectionHidden({ ...visible, opacity: "0", hasLiveAnimation: true })).toBe(false);
  });

  it("flags visibility:hidden with no animation, but not mid-transition", () => {
    expect(isSectionHidden({ ...visible, visibility: "hidden" })).toBe(true);
    expect(
      isSectionHidden({ ...visible, visibility: "hidden", hasLiveAnimation: true }),
    ).toBe(false);
  });

  it("flags near-zero height with no animation, but not mid-animation", () => {
    expect(isSectionHidden({ ...visible, heightPx: 2 })).toBe(true);
    expect(isSectionHidden({ ...visible, heightPx: 2, hasLiveAnimation: true })).toBe(false);
  });

  it("treats display:none as hidden even while animations run", () => {
    expect(isSectionHidden({ ...visible, display: "none", hasLiveAnimation: true })).toBe(true);
  });
});

describe("DesignRenderer health heartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const CONTENT = `<!DOCTYPE html><html><head></head><body><section data-vdid="s1"><h1>One</h1></section></body></html>`;

  it("reports at mount and re-reports on the 60s heartbeat", () => {
    vi.useFakeTimers();
    const reports: DesignRenderHealth[] = [];
    render(
      <DesignRenderer content={CONTENT} tokens={{}} onRenderHealth={(h) => reports.push(h)} />,
    );
    const initial = reports.length;
    expect(initial).toBeGreaterThan(0);
    expect(reports[0].totalSlides).toBe(1);
    act(() => {
      vi.advanceTimersByTime(HEALTH_HEARTBEAT_MS + 100);
    });
    expect(reports.length).toBeGreaterThan(initial);
  });

  it("stops the heartbeat on unmount", () => {
    vi.useFakeTimers();
    const reports: DesignRenderHealth[] = [];
    const { unmount } = render(
      <DesignRenderer content={CONTENT} tokens={{}} onRenderHealth={(h) => reports.push(h)} />,
    );
    unmount();
    const afterUnmount = reports.length;
    act(() => {
      vi.advanceTimersByTime(3 * HEALTH_HEARTBEAT_MS);
    });
    expect(reports.length).toBe(afterUnmount);
  });
});
