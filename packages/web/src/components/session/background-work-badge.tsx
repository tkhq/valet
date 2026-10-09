import { useState } from "react";
import { Clock } from "lucide-react";
import type { LeaseSummary, ListSessionWakeupsResponse, WakeupSummary } from "@valet/api/wire";
import { ApiError } from "~/api/client";
import { useCancelSessionWakeup, useSessionWakeups } from "~/api/queries";
import { Button, ConfirmDialog, Popover, PopoverContent, PopoverTrigger } from "~/components/primitives";

/** One row of background work: a wakeup, or a hold lease (no wakeup owns it). */
export interface BackgroundItem {
  id: string;
  kind: WakeupSummary["kind"] | "hold";
  reason: string;
  /** When the work is stopped (process, watch, hold). */
  deadlineAt?: number;
  /** When a timer fires. */
  fireAt?: number;
}

/** Pure: the rows a person sees. A process or watch lease shows through its wakeup. */
export function backgroundItems(data: ListSessionWakeupsResponse | undefined): BackgroundItem[] {
  if (!data) return [];
  const wakeups: BackgroundItem[] = data.wakeups.map((w) => ({
    id: w.id,
    kind: w.kind,
    reason: w.reason,
    ...(w.deadlineAt !== undefined ? { deadlineAt: w.deadlineAt } : {}),
    ...(w.fireAt !== undefined ? { fireAt: w.fireAt } : {}),
  }));
  const holds: BackgroundItem[] = data.leases
    .filter((l: LeaseSummary) => l.ownerKind === "hold")
    .map((l) => ({ id: l.id, kind: "hold", reason: l.reason, deadlineAt: l.deadlineAt }));
  return [...wakeups, ...holds];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Pure: a future time as "in 5m", "in 3h", or "in 2d". A past time reads "now". */
export function timeUntil(ts: number, now: number = Date.now()): string {
  const diff = ts - now;
  if (diff < MINUTE) return "now";
  if (diff < HOUR) return `in ${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `in ${Math.floor(diff / HOUR)}h`;
  return `in ${Math.floor(diff / DAY)}d`;
}

/** Pure: the badge text, such as "2 background · next deadline in 3h". */
export function badgeLabel(items: BackgroundItem[], now: number = Date.now()): string {
  const deadlines = items.flatMap((i) => (i.deadlineAt !== undefined ? [i.deadlineAt] : []));
  if (deadlines.length > 0) {
    return `${items.length} background · next deadline ${timeUntil(Math.min(...deadlines), now)}`;
  }
  const fires = items.flatMap((i) => (i.fireAt !== undefined ? [i.fireAt] : []));
  if (fires.length > 0) return `${items.length} background · next wakeup ${timeUntil(Math.min(...fires), now)}`;
  return `${items.length} background`;
}

const KIND_LABEL: Record<BackgroundItem["kind"], string> = {
  process: "Process",
  watch: "Watch",
  timer: "Timer",
  hold: "Hold",
};

function cancelError(err: unknown): string {
  if (err instanceof ApiError && err.payload && typeof err.payload === "object") {
    const message = (err.payload as Record<string, unknown>).error;
    if (typeof message === "string" && message) return message;
  }
  return "Could not stop this work. Try again.";
}

/**
 * Session header badge for background work (spec 2026-10-08, fix wave 2
 * H8): "N background · next deadline in 3h". It opens a list of the work,
 * with a Cancel button per row when the person may stop it. Renders nothing
 * while the session has no background work.
 */
export function BackgroundWorkBadge({ sessionId, canCancel }: { sessionId: string; canCancel: boolean }) {
  const { data } = useSessionWakeups(sessionId);
  const cancel = useCancelSessionWakeup(sessionId);
  const [confirming, setConfirming] = useState<BackgroundItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const items = backgroundItems(data);
  if (items.length === 0 && !confirming) return null;

  async function stop(item: BackgroundItem) {
    setError(null);
    try {
      await cancel.mutateAsync(item.id);
      setConfirming(null);
    } catch (err) {
      setError(cancelError(err));
    }
  }

  return (
    <>
      {items.length > 0 && (
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="shrink-0 gap-1.5 text-xs text-muted" aria-label="Background work">
              <Clock className="h-3.5 w-3.5" aria-hidden />
              <span>{badgeLabel(items)}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80">
            <p className="mb-2 text-xs font-medium text-ink">Background work</p>
            <ul className="space-y-2">
              {items.map((item) => (
                <li key={item.id} className="flex items-start gap-2 text-xs">
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-ink">{item.reason}</p>
                    <p className="text-muted">
                      {KIND_LABEL[item.kind]}
                      {item.deadlineAt !== undefined && ` · deadline ${timeUntil(item.deadlineAt)}`}
                      {item.fireAt !== undefined && ` · fires ${timeUntil(item.fireAt)}`}
                    </p>
                  </div>
                  {canCancel && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setError(null);
                        setConfirming(item);
                      }}
                      aria-label={`Cancel ${item.reason}`}
                    >
                      Cancel
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      )}
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirming(null);
            setError(null);
          }
        }}
        title="Stop this background work?"
        description={
          confirming
            ? `This stops "${confirming.reason}". The agent gets a message that you stopped it.`
            : ""
        }
        confirmLabel="Stop it"
        pendingLabel="Stopping…"
        pending={cancel.isPending}
        error={error ?? undefined}
        onConfirm={() => {
          if (confirming) void stop(confirming);
        }}
      />
    </>
  );
}
