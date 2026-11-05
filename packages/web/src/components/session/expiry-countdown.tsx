import { useEffect, useLayoutEffect, useState } from "react";
import { cn } from "~/lib/cn";
import { formatDateTime } from "~/lib/format-when";

/** "Expires in 8 min", "Expires in 40 s", or "Expired", from milliseconds left. */
export function expiryLabel(msLeft: number): string {
  if (msLeft <= 0) return "Expired";
  const seconds = Math.ceil(msLeft / 1000);
  if (seconds < 60) return `Expires in ${seconds} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `Expires in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `Expires in ${hours} h`;
}

/**
 * A live countdown to a deadline. It turns amber in the last two minutes.
 * It ticks every second near the end and every 15 seconds before that.
 */
export function ExpiryCountdown({ expiresAt, className, onExpiredChange, compactBelowSm = false, descriptionId }: {
  expiresAt: number;
  className?: string;
  onExpiredChange?: (expired: boolean) => void;
  compactBelowSm?: boolean;
  descriptionId?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  const left = expiresAt - now;
  const expired = left <= 0;
  useLayoutEffect(() => { onExpiredChange?.(expired); }, [expired, onExpiredChange]);
  useEffect(() => {
    if (left <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), left < 120_000 ? 1000 : 15_000);
    return () => clearTimeout(timer);
  }, [left]);
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  const deadline = new Date(expiresAt);
  const expiryTime = deadline.toDateString() === new Date(now).toDateString()
    ? deadline.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : formatDateTime(expiresAt);
  const label = expiryLabel(left);
  return <>
    <span role="timer" aria-hidden={descriptionId ? true : undefined} aria-label={descriptionId ? undefined : label} className={cn("tabular-nums text-xs", !expired && left < 120_000 ? "text-amber-600 dark:text-amber-400" : "text-muted", className)}>
      {compactBelowSm ? <>
        <span className="sm:hidden">{label.replace("Expires in ", "")}</span>
        <span className="hidden sm:inline">{label}</span>
      </> : label}
    </span>
    {descriptionId && <span id={descriptionId} hidden>{expired ? "Expired" : `Expires at ${expiryTime}`}</span>}
  </>;
}
