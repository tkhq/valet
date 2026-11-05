import { useEffect, useRef } from "react";
import { usePatchMe } from "~/api/settings";

/** The browser's IANA timezone, or undefined when `Intl` cannot tell. */
export function browserTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * TKAI-584: send the browser timezone once per account. The server applies it
 * only if the timezone is empty and `timezoneReportDone` is false, then sets
 * the flag. A set or a clear in Settings sets the flag too, so a clear sticks.
 * The ref stops a retry loop if the save fails.
 */
export function useReportTimezoneOnce(
  me: { timezone: string | null; timezoneReportDone: boolean } | undefined,
) {
  const patchMe = usePatchMe();
  const attempted = useRef(false);
  const loaded = me !== undefined;
  const pending = loaded && me.timezone === null && !me.timezoneReportDone;
  useEffect(() => {
    if (!pending || attempted.current) return;
    const tz = browserTimezone();
    if (!tz) return;
    attempted.current = true;
    patchMe.mutate({ reportedTimezone: tz });
  }, [pending]); // eslint-disable-line react-hooks/exhaustive-deps
}
