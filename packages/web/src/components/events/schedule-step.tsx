/**
 * The routine's schedule step (docs/specs/2026-10-16-presence-hub-design.md
 * Part H): days of the week and a time in a named timezone make the cron. A
 * cron typed under Advanced replaces them.
 */
import { useMemo } from "react";
import { Button, Input, Label, Select } from "~/components/primitives";
import { timeZoneOptions } from "~/lib/time-zones";

/** Days of the week as cron numbers, Monday first. */
export const WEEK: readonly { day: number; label: string }[] = [
  { day: 1, label: "Mon" }, { day: 2, label: "Tue" }, { day: 3, label: "Wed" }, { day: 4, label: "Thu" },
  { day: 5, label: "Fri" }, { day: 6, label: "Sat" }, { day: 0, label: "Sun" },
];
export const WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5];

/**
 * The cron for days of the week and a time: `0 9 * * 1-5` for weekdays at
 * 09:00. Empty when no day is picked or the time does not parse.
 */
export function cronFromDayAndTime(days: ReadonlySet<number>, time: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (match === null || days.size === 0) return "";
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return "";
  const sorted = [...days].sort((a, b) => a - b);
  const dow = sorted.length === 7 ? "*" : sorted.join(",") === WEEKDAYS.join(",") ? "1-5" : sorted.join(",");
  return `${minute} ${hour} * * ${dow}`;
}

/**
 * The schedule step: days of the week and a time in a timezone make the
 * cron. A cron typed under Advanced replaces them.
 */
export function ScheduleMatchStep({
  days,
  onDaysChange,
  time,
  onTimeChange,
  cron,
  cronOverride,
  onCronChange,
  timezone,
  onTimezoneChange,
}: {
  days: ReadonlySet<number>;
  onDaysChange: (v: ReadonlySet<number>) => void;
  time: string;
  onTimeChange: (v: string) => void;
  /** The effective cron: the override, else the one the days and time make. */
  cron: string;
  cronOverride: string | null;
  onCronChange: (v: string) => void;
  timezone: string;
  onTimezoneChange: (v: string) => void;
}) {
  const zones = useMemo(() => timeZoneOptions([timezone, "UTC"]), [timezone]);
  function toggle(day: number) {
    const next = new Set(days);
    if (next.has(day)) next.delete(day);
    else next.add(day);
    onDaysChange(next);
  }
  return (
    <div className="space-y-4">
      <fieldset className="space-y-3" disabled={cronOverride !== null}>
        <legend className="mb-1 text-sm font-medium text-ink">Day and time</legend>
        <div role="group" aria-label="Days" className="flex flex-wrap gap-x-3 gap-y-1">
          {WEEK.map(({ day, label }) => (
            <label key={day} className="flex min-h-11 items-center gap-1.5 text-sm text-ink sm:min-h-0">
              <input type="checkbox" checked={days.has(day)} onChange={() => toggle(day)} />
              {label}
            </label>
          ))}
        </div>
        {days.size === 0 && cronOverride === null && <p className="text-xs text-danger-500">Pick at least one day.</p>}
        <div className="grid gap-1">
          <Label htmlFor="automation-time">Time</Label>
          <Input id="automation-time" type="time" value={time} onChange={(e) => onTimeChange(e.target.value)} className="w-32" />
        </div>
      </fieldset>
      {/* The timezone applies to an Advanced cron too, so it stays open when one is typed. */}
      <div className="grid min-w-0 gap-1">
        <Label htmlFor="automation-timezone">Timezone</Label>
        <Select
          id="automation-timezone"
          value={timezone}
          onChange={(e) => onTimezoneChange(e.target.value)}
          className="w-full min-w-0 truncate"
        >
          {zones.map((zone) => (
            <option key={zone.value} value={zone.value}>{zone.label}</option>
          ))}
        </Select>
      </div>
      <details open={cronOverride !== null} className="text-sm text-ink">
        <summary className="cursor-pointer text-sm text-muted">Advanced</summary>
        <div className="mt-2 grid gap-1">
          <Label htmlFor="automation-cron">Cron</Label>
          <Input
            id="automation-cron"
            value={cron}
            onChange={(e) => onCronChange(e.target.value)}
            placeholder="0 9 * * 1-5"
          />
          <p className="text-xs text-muted">
            Five fields: minute hour day-of-month month day-of-week. A cron you type here replaces the day and time.
          </p>
          {cronOverride !== null && (
            <Button type="button" variant="ghost" size="sm" className="justify-self-start" onClick={() => onCronChange("")}>
              Use the day and time
            </Button>
          )}
        </div>
      </details>
    </div>
  );
}
