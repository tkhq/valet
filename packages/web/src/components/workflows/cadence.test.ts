/**
 * `describeCadence` pins the card copy to the cron a template actually
 * arms. The fallback cases matter most: a card that shows a raw expression
 * is readable, a card that describes the wrong cadence is a lie.
 */
import { describe, expect, it } from "vitest";
import { describeCadence } from "./cadence";

describe("describeCadence", () => {
  it("says a template with no schedule runs on demand", () => {
    expect(describeCadence(null)).toBe("Runs when you start it");
  });

  it("describes a weekday morning cron", () => {
    expect(describeCadence({ cron: "0 13 * * 1-5", timezone: "UTC" })).toBe(
      "Every weekday at 1:00 PM UTC",
    );
  });

  it("describes a daily cron", () => {
    expect(describeCadence({ cron: "0 6 * * *", timezone: "UTC" })).toBe(
      "Every day at 6:00 AM UTC",
    );
  });

  it("names a single day of the week", () => {
    expect(describeCadence({ cron: "0 14 * * 1", timezone: "America/Denver" })).toBe(
      "Every Monday at 2:00 PM America/Denver",
    );
  });

  it("treats day 7 as Sunday, as cron does", () => {
    expect(describeCadence({ cron: "30 9 * * 7", timezone: "UTC" })).toBe(
      "Every Sunday at 9:30 AM UTC",
    );
  });

  it("prints midnight and noon on a 12-hour clock", () => {
    expect(describeCadence({ cron: "0 0 * * *", timezone: "UTC" })).toBe(
      "Every day at 12:00 AM UTC",
    );
    expect(describeCadence({ cron: "0 12 * * *", timezone: "UTC" })).toBe(
      "Every day at 12:00 PM UTC",
    );
  });

  it("falls back to the raw expression for a step or list it cannot phrase", () => {
    expect(describeCadence({ cron: "*/15 * * * *", timezone: "UTC" })).toBe(
      "*/15 * * * * (UTC)",
    );
    expect(describeCadence({ cron: "0 9 * * 1,3,5", timezone: "UTC" })).toBe(
      "0 9 * * 1,3,5 (UTC)",
    );
  });

  it("falls back when the schedule pins a day of the month", () => {
    expect(describeCadence({ cron: "0 9 1 * *", timezone: "UTC" })).toBe("0 9 1 * * (UTC)");
  });

  it("falls back on a malformed expression instead of guessing", () => {
    expect(describeCadence({ cron: "0 9 * *", timezone: "UTC" })).toBe("0 9 * * (UTC)");
    expect(describeCadence({ cron: "0 99 * * *", timezone: "UTC" })).toBe("0 99 * * * (UTC)");
  });
});
