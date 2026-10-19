// @vitest-environment jsdom
/**
 * The health strip (docs/specs/2026-10-16-presence-hub-design.md Part D
 * step 1.4): last acted or fired, the count, the fault, and a 30-day pulse
 * with the last day emphasized. Review Focus 2: a line that never acted.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HealthStrip, barHeight, perDayCounts } from "./health-strip";

const DAY = 86_400_000;

function bars(): HTMLElement[] {
  return Array.from(screen.getByRole("img", { name: "Activity over the last 30 days" }).querySelectorAll<HTMLElement>("span"));
}

describe("HealthStrip", () => {
  it("reads never, 0, and 30 empty bars for a line that never acted (Review Focus 2)", () => {
    render(<HealthStrip lastAt={null} count={0} perDay={Array.from({ length: 30 }, () => 0)} labels={{ last: "last acted" }} />);
    const strip = screen.getByRole("region", { name: "Health" });
    expect(within(strip).getByText("never")).toBeTruthy();
    expect(within(strip).getByText("last acted")).toBeTruthy();
    expect(within(strip).getByText("0")).toBeTruthy();
    expect(within(strip).getByText("times in 30 days")).toBeTruthy();
    expect(within(strip).queryByText("Needs attention")).toBeNull();
    const pulse = bars();
    expect(pulse).toHaveLength(30);
    expect(pulse.every((bar) => bar.style.height === "2px")).toBe(true);
  });

  it("draws 30 bars by count with the last day emphasized", () => {
    const perDay = Array.from({ length: 30 }, (_, day) => (day === 10 ? 4 : day === 29 ? 2 : 0));
    render(<HealthStrip lastAt={Date.now() - 2 * 3_600_000} count={6} perDay={perDay} labels={{ last: "last acted" }} />);
    const pulse = bars();
    expect(pulse).toHaveLength(30);
    expect(pulse[10]?.style.height).toBe("32px");
    expect(pulse[29]?.style.height).toBe("16px");
    expect(pulse[29]?.className).toMatch(/\bbg-moss\b/);
    expect(pulse.slice(0, 29).every((bar) => bar.className.includes("bg-moss-wash"))).toBe(true);
    expect(screen.getByText("2h ago")).toBeTruthy();
    expect(screen.getByText("6")).toBeTruthy();
  });

  it("names the fault in the danger color and pads a short history to 30 days", () => {
    render(
      <HealthStrip
        lastAt={null}
        count={0}
        perDay={[1]}
        fault={{ title: "Needs attention", detail: "Platform CI is archived" }}
        labels={{ last: "last fired" }}
      />,
    );
    expect(screen.getByText("Needs attention").className).toMatch(/text-danger-500/);
    expect(screen.getByText("Platform CI is archived")).toBeTruthy();
    expect(screen.getByText("last fired")).toBeTruthy();
    expect(bars()).toHaveLength(30);
    expect(bars()[29]?.getAttribute("title")).toBe("1 fired");
  });

  it("hides the count when the history does not record it", () => {
    render(<HealthStrip lastAt={null} count={null} perDay={[]} labels={{ last: "last fired" }} />);
    expect(screen.queryByText("times in 30 days")).toBeNull();
  });
});

describe("perDayCounts and barHeight", () => {
  it("counts by UTC day; 29 days ago counts and 30 days ago does not", () => {
    const now = Date.UTC(2026, 9, 18, 12);
    const counts = perDayCounts([now, now - 1_000, now - 29 * DAY, now - 30 * DAY, now + DAY], now);
    expect(counts).toHaveLength(30);
    expect(counts[29]).toBe(2);
    expect(counts[0]).toBe(1);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("keeps every bar between 2px and 32px", () => {
    expect(barHeight(0, 5)).toBe(2);
    expect(barHeight(5, 5)).toBe(32);
    expect(barHeight(1, 100)).toBe(2);
  });
});
