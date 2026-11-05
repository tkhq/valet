// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { formatDateTime, formatWhen } from "~/lib/format-when";
import { Time } from "./time";

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const FIVE_MINUTES_AGO = NOW - 5 * 60_000;

describe("Time", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("shows relative time, with the ISO dateTime and the full date as title", () => {
    render(<Time ts={FIVE_MINUTES_AGO} className="tabular-nums" />);
    const time = screen.getByText("5m ago");
    expect(time.tagName).toBe("TIME");
    expect(time.getAttribute("dateTime")).toBe(new Date(FIVE_MINUTES_AGO).toISOString());
    expect(time.getAttribute("title")).toBe(formatDateTime(FIVE_MINUTES_AGO));
    expect(time.className).toBe("tabular-nums");
  });

  it("shows the absolute time for format=\"absolute\"", () => {
    render(<Time ts={FIVE_MINUTES_AGO} format="absolute" />);
    const time = screen.getByText(formatWhen(FIVE_MINUTES_AGO));
    expect(time.getAttribute("title")).toBe(formatDateTime(FIVE_MINUTES_AGO));
  });

  it("leaves dateTime off for an invalid timestamp instead of throwing", () => {
    const { container } = render(<Time ts={Number.NaN} />);
    expect(container.querySelector("time")?.hasAttribute("dateTime")).toBe(false);
  });
});
