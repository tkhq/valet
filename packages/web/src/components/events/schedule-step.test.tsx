// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScheduleMatchStep, WEEKDAYS, cronFromDayAndTime } from "./schedule-step";

describe("cronFromDayAndTime", () => {
  it("makes the cron from days and a time", () => {
    expect(cronFromDayAndTime(new Set(WEEKDAYS), "09:00")).toBe("0 9 * * 1-5");
    expect(cronFromDayAndTime(new Set([1, 3, 5]), "07:30")).toBe("30 7 * * 1,3,5");
    expect(cronFromDayAndTime(new Set([0, 1, 2, 3, 4, 5, 6]), "18:05")).toBe("5 18 * * *");
    expect(cronFromDayAndTime(new Set([6, 0]), "08:00")).toBe("0 8 * * 0,6");
  });

  it("is empty with no day or a time that does not parse", () => {
    expect(cronFromDayAndTime(new Set(), "09:00")).toBe("");
    expect(cronFromDayAndTime(new Set([1]), "")).toBe("");
    expect(cronFromDayAndTime(new Set([1]), "25:00")).toBe("");
  });
});

function renderStep(over: { days?: ReadonlySet<number>; cronOverride?: string | null; timezone?: string } = {}) {
  const props = {
    days: over.days ?? new Set(WEEKDAYS),
    onDaysChange: vi.fn(),
    time: "09:00",
    onTimeChange: vi.fn(),
    cron: over.cronOverride ?? "0 9 * * 1-5",
    cronOverride: over.cronOverride ?? null,
    onCronChange: vi.fn(),
    timezone: over.timezone ?? "America/Denver",
    onTimezoneChange: vi.fn(),
  };
  render(<ScheduleMatchStep {...props} />);
  return props;
}

describe("ScheduleMatchStep", () => {
  it("opens on weekdays at the given time, and a day toggles", () => {
    const props = renderStep();
    const days = within(screen.getByRole("group", { name: "Days" }));
    expect(days.getAllByRole("checkbox").map((box) => [box.parentElement?.textContent, (box as HTMLInputElement).checked])).toEqual([
      ["Mon", true], ["Tue", true], ["Wed", true], ["Thu", true], ["Fri", true], ["Sat", false], ["Sun", false],
    ]);
    fireEvent.click(days.getByLabelText("Sat"));
    expect([...props.onDaysChange.mock.calls[0][0]].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect((screen.getByLabelText("Cron") as HTMLInputElement).value).toBe("0 9 * * 1-5");
  });

  it("asks for a day when none is picked", () => {
    renderStep({ days: new Set() });
    expect(screen.getByText("Pick at least one day.")).toBeTruthy();
  });

  it("lists timezones by their long names, once each, with the given zone selected", () => {
    renderStep({ timezone: "UTC" });
    const zone = screen.getByLabelText("Timezone") as HTMLSelectElement;
    expect(zone.value).toBe("UTC");
    const values = [...zone.options].map((o) => o.value);
    expect(values.filter((v) => v === "UTC")).toHaveLength(1);
    const denver = [...zone.options].find((o) => o.value === "America/Denver");
    expect(denver?.textContent).toMatch(/^Mountain (Standard|Daylight) Time \(Denver\)$/);
  });

  it("disables the day and time while a typed cron wins, and keeps the timezone open", () => {
    const props = renderStep({ cronOverride: "0 6 1 * *" });
    expect(screen.getByLabelText("Time").matches(":disabled")).toBe(true);
    expect(screen.getByLabelText("Timezone").matches(":disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Use the day and time" }));
    expect(props.onCronChange).toHaveBeenCalledWith("");
  });
});
