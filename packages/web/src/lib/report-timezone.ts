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
 * TKAI-584: if the signed-in user has no stored timezone, send the browser's
 * once. A stored value is never sent over, so a value the user set always
 * wins. The ref stops a retry loop if the save fails.
 */
export function useReportTimezoneOnce(me: { timezone: string | null } | undefined) {
  const patchMe = usePatchMe();
  const attempted = useRef(false);
  const loaded = me !== undefined;
  const stored = me?.timezone ?? null;
  useEffect(() => {
    if (!loaded || stored !== null || attempted.current) return;
    const tz = browserTimezone();
    if (!tz) return;
    attempted.current = true;
    patchMe.mutate({ timezone: tz });
  }, [loaded, stored]); // eslint-disable-line react-hooks/exhaustive-deps
}
