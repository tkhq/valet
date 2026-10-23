import { useEffect, useState } from "react";
import { cn } from "~/lib/cn";

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
export function ExpiryCountdown({ expiresAt, className }: { expiresAt: number; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  const left = expiresAt - now;
  useEffect(() => {
    if (left <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), left < 120_000 ? 1000 : 15_000);
    return () => clearTimeout(timer);
  }, [left]);
  return <span role="timer" className={cn("tabular-nums text-xs", left < 120_000 ? "text-amber-600 dark:text-amber-400" : "text-muted", className)}>
    {expiryLabel(left)}
  </span>;
}
