import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Bell, Clock, Eye, Lock, Terminal, Timer, type LucideIcon } from "lucide-react";
import type { LeaseSummary, ListSessionWakeupsResponse, ListThreadFeedersResponse, WakeupSummary } from "@valet/api/wire";
import { ApiError } from "~/api/client";
import { useCancelSessionWakeup, useSessionWakeups } from "~/api/queries";
import { useThreadFeeders } from "~/api/presence-feeders";
import { Button, ConfirmDialog, Popover, PopoverContent, PopoverTrigger, Tooltip } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { formatWhen } from "~/lib/format-when";

/** One row of background work: a wakeup, or a hold lease (no wakeup owns it). */
export interface BackgroundItem {
  id: string;
  kind: WakeupSummary["kind"] | "hold";
  reason: string;
  /** The thread the work belongs to. Absent on session-level work. */
  threadId?: string;
  /** When the work is stopped (process, watch, hold). */
  deadlineAt?: number;
  /** When a timer fires. */
  fireAt?: number;
  /** `event`: the subject's display label (spec Part H). */
  subjectLabel?: string;
  /** `event`: the subject's link, when the owning plugin returns one. */
  subjectUrl?: string;
  /** `event`: the number of match clauses it waits on. */
  clauseCount?: number;
  createdAt: number;
  /** `pending` while a process or watch is still starting. A hold is always running. */
  status: WakeupSummary["status"];
}

/** Pure: the rows a person sees. A process or watch lease shows through its wakeup. */
export function backgroundItems(data: ListSessionWakeupsResponse | undefined): BackgroundItem[] {
  if (!data) return [];
  const wakeups: BackgroundItem[] = data.wakeups.map((w) => ({
    id: w.id,
    kind: w.kind,
    reason: w.reason,
    threadId: w.threadId,
    ...(w.deadlineAt !== undefined ? { deadlineAt: w.deadlineAt } : {}),
    ...(w.fireAt !== undefined ? { fireAt: w.fireAt } : {}),
    ...(w.subjectLabel !== undefined ? { subjectLabel: w.subjectLabel } : {}),
    ...(w.subjectUrl !== undefined ? { subjectUrl: w.subjectUrl } : {}),
    ...(w.clauseCount !== undefined ? { clauseCount: w.clauseCount } : {}),
    createdAt: w.createdAt,
    status: w.status,
  }));
  const holds: BackgroundItem[] = data.leases
    .filter((l: LeaseSummary) => l.ownerKind === "hold")
    .map((l) => ({
      id: l.id,
      kind: "hold",
      reason: l.reason,
      ...(l.threadId !== undefined ? { threadId: l.threadId } : {}),
      deadlineAt: l.deadlineAt,
      createdAt: l.createdAt,
      status: "running",
    }));
  return [...wakeups, ...holds];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Pure: a future time as "in 5m", "in 3h", or "in 2d", rounded to the
 * nearest unit: 47h reads "in 2d" and 90m reads "in 2h". A time under a
 * minute away, or past, reads "now".
 */
export function timeUntil(ts: number, now: number = Date.now()): string {
  const diff = ts - now;
  if (diff < MINUTE) return "now";
  const minutes = Math.round(diff / MINUTE);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(diff / HOUR);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(diff / DAY)}d`;
}

/** Pure: how long ago `ts` was, as "under 1m", "5m", "3h", or "2d". */
export function timeSince(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  if (diff < MINUTE) return "under 1m";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  return `${Math.floor(diff / DAY)}d`;
}

/**
 * Pure: the soonest event of any kind, such as "next wakeup in 26m" for a
 * timer or "next deadline in 3h" for a deadline. Undefined when no item
 * has a time.
 */
export function nextEventLabel(items: BackgroundItem[], now: number = Date.now()): string | undefined {
  const events = items.flatMap((i) => [
    ...(i.deadlineAt !== undefined ? [{ at: i.deadlineAt, word: "deadline" }] : []),
    ...(i.fireAt !== undefined ? [{ at: i.fireAt, word: "wakeup" }] : []),
  ]);
  if (events.length === 0) return undefined;
  const next = events.reduce((a, b) => (b.at < a.at ? b : a));
  return `next ${next.word} ${timeUntil(next.at, now)}`;
}

/** Pure: the open thread's items, then the rest (other threads and session-level work). */
export function splitByThread(
  items: BackgroundItem[],
  threadId: string | undefined,
): { own: BackgroundItem[]; other: BackgroundItem[] } {
  const own = threadId === undefined ? [] : items.filter((i) => i.threadId === threadId);
  const other = items.filter((i) => threadId === undefined || i.threadId !== threadId);
  return { own, other };
}

const KIND_ORDER: BackgroundItem["kind"][] = ["process", "watch", "timer", "hold"];

const KIND_NOUN: Record<BackgroundItem["kind"], [singular: string, plural: string]> = {
  process: ["process", "processes"],
  watch: ["watch", "watches"],
  timer: ["timer", "timers"],
  event: ["event waiter", "event waiters"],
  hold: ["hold", "holds"],
};

const KIND_ICON: Record<BackgroundItem["kind"], LucideIcon> = {
  process: Terminal,
  watch: Eye,
  timer: Timer,
  event: Bell,
  hold: Lock,
};

/** The open thread's event waiters, collapsed to the oldest one plus a count of the rest. */
export interface EventWaitLine {
  id: string;
  label: string;
  /** Other event waiters of the open thread, named nowhere (spec Part H fix round 1). */
  moreCount: number;
}

/** The status line's content: the soonest event, the open thread's counts per kind, and a count of the rest. */
export interface StatusLine {
  next?: string;
  kinds: Array<{ kind: BackgroundItem["kind"]; label: string }>;
  /**
   * The open thread's event waiters, named by the oldest one's subject
   * instead of counted generically (spec Part H): "waiting on <subject
   * label>", or "waiting on <subject label> +N more" for several.
   */
  eventWait?: EventWaitLine;
  /** Items outside the open thread. The line counts them and never names them. */
  otherCount: number;
}

/**
 * Pure: the composer status line for the open thread. The soonest event
 * comes from the open thread's items, or from all items when the open
 * thread has none.
 */
export function statusLine(items: BackgroundItem[], threadId: string | undefined, now: number = Date.now()): StatusLine {
  const { own, other } = splitByThread(items, threadId);
  const next = nextEventLabel(own.length > 0 ? own : items, now);
  const kinds = KIND_ORDER.flatMap((kind) => {
    const count = own.filter((i) => i.kind === kind).length;
    if (count === 0) return [];
    const [singular, plural] = KIND_NOUN[kind];
    return [{ kind, label: `${count} ${count === 1 ? singular : plural}` }];
  });
  // Several event waiters collapse to the oldest one's subject plus a
  // count, rather than naming each (fix round 1, controller ruling).
  const eventItems = own.filter((i) => i.kind === "event").sort((a, b) => a.createdAt - b.createdAt);
  const [oldest] = eventItems;
  const eventWait: EventWaitLine | undefined =
    oldest === undefined ? undefined : { id: oldest.id, label: oldest.subjectLabel ?? oldest.reason, moreCount: eventItems.length - 1 };
  return { ...(next !== undefined ? { next } : {}), kinds, ...(eventWait !== undefined ? { eventWait } : {}), otherCount: other.length };
}

/** Pure: the text form of an event-wait line: "waiting on X" or "waiting on X +2 more". */
export function eventWaitText(wait: EventWaitLine): string {
  return wait.moreCount > 0 ? `waiting on ${wait.label} +${wait.moreCount} more` : `waiting on ${wait.label}`;
}

/** Pure: the status line as one string, such as "next wakeup in 26m · 1 process · +2 in other threads". */
export function statusLineText(line: StatusLine): string {
  return [
    ...(line.next !== undefined ? [line.next] : []),
    ...line.kinds.map((k) => k.label),
    ...(line.eventWait !== undefined ? [eventWaitText(line.eventWait)] : []),
    ...(line.otherCount > 0 ? [`+${line.otherCount} in other threads`] : []),
  ].join(" · ");
}

const KIND_LABEL: Record<BackgroundItem["kind"], string> = {
  process: "Process",
  watch: "Watch",
  timer: "Timer",
  event: "Event waiter",
  hold: "Hold",
};

/**
 * Pure: one row's detail, such as "Process · running 3h · deadline in 2d".
 * A process or watch still starting reads "starting". The deadline is when
 * the work is stopped, not when it is expected to finish.
 */
export function itemDetail(item: BackgroundItem, now: number = Date.now()): string {
  const parts = [KIND_LABEL[item.kind]];
  if (item.kind === "timer") {
    if (item.fireAt !== undefined) parts.push(`fires ${timeUntil(item.fireAt, now)}`);
    return parts.join(" · ");
  }
  parts.push(item.status === "pending" ? "starting" : `running ${timeSince(item.createdAt, now)}`);
  if (item.deadlineAt !== undefined) parts.push(`deadline ${timeUntil(item.deadlineAt, now)}`);
  return parts.join(" · ");
}

/** Pure: the state word for one item: a timer waits, a hold holds, a process or watch runs (or starts). */
export function itemStatus(item: BackgroundItem): "waiting" | "held" | "starting" | "running" {
  if (item.kind === "timer") return "waiting";
  if (item.kind === "hold") return "held";
  return item.status === "pending" ? "starting" : "running";
}

/**
 * Pure: the thread card's detail for one item, such as "Timer · waiting ·
 * fires in 26m" or "Process · running · deadline in 1d".
 */
export function sectionDetail(item: BackgroundItem, now: number = Date.now()): string {
  const parts: string[] = [KIND_LABEL[item.kind], itemStatus(item)];
  if (item.fireAt !== undefined) parts.push(`fires ${timeUntil(item.fireAt, now)}`);
  else if (item.deadlineAt !== undefined) parts.push(`deadline ${timeUntil(item.deadlineAt, now)}`);
  return parts.join(" · ");
}

/** The event card section's detail: the subject label, the clause count, and the deadline. */
export interface EventSectionDetail {
  label: string;
  clauses?: string;
  deadline?: string;
}

/**
 * Pure: the thread card section's detail for one event waiter (spec Part
 * H): the subject's display label, the clause count, and the deadline.
 * The caller renders the label as a link when the item carries a
 * `subjectUrl`.
 */
export function eventSectionDetail(item: BackgroundItem, now: number = Date.now()): EventSectionDetail {
  const label = item.subjectLabel ?? item.reason;
  const clauses = item.clauseCount !== undefined ? `${item.clauseCount} ${item.clauseCount === 1 ? "clause" : "clauses"}` : undefined;
  const deadline = item.deadlineAt !== undefined ? `deadline ${timeUntil(item.deadlineAt, now)}` : undefined;
  return { label, ...(clauses !== undefined ? { clauses } : {}), ...(deadline !== undefined ? { deadline } : {}) };
}

/** One link in the "Fed by" line: a listener or a routine that delivers
 * into this thread (spec Part G). */
export interface FeederLink {
  kind: "listener" | "routine";
  id: string;
  name: string;
}

/** Pure: the "Fed by" line's links, listeners before routines. Empty when
 * the thread has no feeders, or the read is still loading or 404s. */
export function feederLinks(feeders: ListThreadFeedersResponse | undefined): FeederLink[] {
  if (!feeders) return [];
  return [
    ...feeders.listeners.map((f) => ({ kind: "listener" as const, id: f.id, name: f.name })),
    ...feeders.routines.map((f) => ({ kind: "routine" as const, id: f.id, name: f.name })),
  ];
}

/** The routines tab has no per-routine page yet, so a routine feeder links
 * to the tab filtered to it by id (spec Part G). */
function routineHref(id: string): string {
  return `/presence/routines?routine=${encodeURIComponent(id)}`;
}

/** The "Fed by" line: the listeners and routines that deliver into this
 * thread, each linking to its own page. Renders nothing for an empty list. */
function FeedByLine({ feeders }: { feeders: ListThreadFeedersResponse | undefined }) {
  const links = feederLinks(feeders);
  if (links.length === 0) return null;
  return (
    <p className="text-xs text-muted">
      Fed by:{" "}
      {links.map((link, index) => (
        <Fragment key={`${link.kind}-${link.id}`}>
          {index > 0 && ", "}
          {link.kind === "listener" ? (
            <Link to="/presence/listeners/$id" params={{ id: link.id }} className="text-moss hover:underline">
              {link.name}
            </Link>
          ) : (
            <a href={routineHref(link.id)} className="text-moss hover:underline">
              {link.name}
            </a>
          )}
        </Fragment>
      ))}
    </p>
  );
}

/** Pure: the exact time behind an item's relative time, for a hover title. */
export function itemTimeTitle(item: BackgroundItem): string | undefined {
  if (item.fireAt !== undefined) return `Fires ${formatWhen(item.fireAt)}`;
  if (item.deadlineAt !== undefined) return `Stops ${formatWhen(item.deadlineAt)}`;
  return undefined;
}

/** Pure: the soonest timer fire time of each thread. Only timers count; other kinds get no thread-list line. */
export function threadTimerWaits(data: ListSessionWakeupsResponse | undefined): Map<string, number> {
  const waits = new Map<string, number>();
  for (const w of data?.wakeups ?? []) {
    if (w.kind !== "timer" || w.fireAt === undefined) continue;
    const current = waits.get(w.threadId);
    if (current === undefined || w.fireAt < current) waits.set(w.threadId, w.fireAt);
  }
  return waits;
}

/** One thread's event waits for its list row: the oldest waiter's subject label and how many others wait. */
export interface ThreadEventWait {
  label: string;
  moreCount: number;
}

/** Pure: each thread's event waits, named by the oldest waiter, like the composer line. */
export function threadEventWaits(data: ListSessionWakeupsResponse | undefined): Map<string, ThreadEventWait> {
  const byThread = new Map<string, Array<{ createdAt: number; label: string }>>();
  for (const w of data?.wakeups ?? []) {
    if (w.kind !== "event" || w.subjectLabel === undefined) continue;
    const list = byThread.get(w.threadId) ?? [];
    list.push({ createdAt: w.createdAt, label: w.subjectLabel });
    byThread.set(w.threadId, list);
  }
  const waits = new Map<string, ThreadEventWait>();
  for (const [threadId, list] of byThread) {
    const oldest = list.reduce((a, b) => (b.createdAt < a.createdAt ? b : a));
    waits.set(threadId, { label: oldest.label, moreCount: list.length - 1 });
  }
  return waits;
}

/** The current time, refreshed every 30 seconds while `active`, so relative times stay current between polls. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

function cancelError(err: unknown): string {
  if (err instanceof ApiError && err.payload && typeof err.payload === "object") {
    const message = (err.payload as Record<string, unknown>).error;
    if (typeof message === "string" && message) return message;
  }
  return "Could not stop this work. Try again.";
}

/**
 * The cancel step for one item: `ask(item)` opens a confirm that names the
 * reason, and the confirm stops the work. Render `dialog` once in the caller.
 */
export function useBackgroundWorkCancel(sessionId: string): { ask: (item: BackgroundItem) => void; dialog: ReactNode } {
  const cancel = useCancelSessionWakeup(sessionId);
  const [confirming, setConfirming] = useState<BackgroundItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function stop(item: BackgroundItem) {
    setError(null);
    try {
      await cancel.mutateAsync(item.id);
      setConfirming(null);
    } catch (err) {
      setError(cancelError(err));
    }
  }

  const dialog = (
    <ConfirmDialog
      open={confirming !== null}
      onOpenChange={(open) => {
        if (!open) {
          setConfirming(null);
          setError(null);
        }
      }}
      title="Stop this background work?"
      description={confirming ? `This stops "${confirming.reason}". The agent gets a message that you stopped it.` : ""}
      confirmLabel="Stop it"
      pendingLabel="Stopping…"
      pending={cancel.isPending}
      error={error ?? undefined}
      onConfirm={() => {
        if (confirming) void stop(confirming);
      }}
    />
  );
  return {
    ask: (item) => {
      setError(null);
      setConfirming(item);
    },
    dialog,
  };
}

function KindIcon({ kind, className }: { kind: BackgroundItem["kind"]; className?: string }) {
  const Icon = KIND_ICON[kind];
  return <Icon className={cn("h-3.5 w-3.5 shrink-0", className)} aria-hidden />;
}

function ManageList({
  items,
  now,
  canCancel,
  onCancel,
  label,
}: {
  items: BackgroundItem[];
  now: number;
  canCancel: boolean;
  onCancel: (item: BackgroundItem) => void;
  label: string;
}) {
  return (
    <ul className="space-y-2" aria-label={label}>
      {items.map((item) => (
        <li key={item.id} className="flex items-start gap-2 text-xs">
          <KindIcon kind={item.kind} className="mt-0.5 text-muted" />
          <div className="min-w-0 flex-1">
            <p className="break-words text-ink">{item.reason}</p>
            <p className="text-muted" title={itemTimeTitle(item)}>{itemDetail(item, now)}</p>
          </div>
          {canCancel && (
            <Button variant="secondary" size="sm" onClick={() => onCancel(item)} aria-label={`Cancel ${item.reason}`}>
              Cancel
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Composer status line for background work (spec 2026-10-08, review UI
 * placement): "next wakeup in 26m · 1 process · 1 hold · +2 in other
 * threads". It counts the open thread's work per kind and counts the rest
 * without names. It opens a list of the work, with a Cancel per row when
 * the person may stop it. Renders nothing while the session has no
 * background work.
 */
export function BackgroundWorkStatusLine({
  sessionId,
  threadId,
  canCancel,
  className,
}: {
  sessionId: string;
  threadId: string | undefined;
  canCancel: boolean;
  /** Spacing for the line's button, from the host layout. */
  className?: string;
}) {
  const { data } = useSessionWakeups(sessionId);
  const items = backgroundItems(data);
  const now = useNow(items.length > 0);
  const { ask, dialog } = useBackgroundWorkCancel(sessionId);
  if (items.length === 0) return <>{dialog}</>;

  const line = statusLine(items, threadId, now);
  const { own, other } = splitByThread(items, threadId);
  const segments: ReactNode[] = [
    ...(line.next !== undefined
      ? [<span key="next" className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />{line.next}</span>]
      : []),
    ...line.kinds.map((k) => (
      <span key={k.kind} className="inline-flex items-center gap-1"><KindIcon kind={k.kind} />{k.label}</span>
    )),
    ...(line.eventWait !== undefined
      ? [<span key={`event-${line.eventWait.id}`} className="inline-flex items-center gap-1"><KindIcon kind="event" />{eventWaitText(line.eventWait)}</span>]
      : []),
    ...(line.otherCount > 0 ? [<span key="other">+{line.otherCount} in other threads</span>] : []),
  ];

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Background work: ${statusLineText(line)}`}
            className={cn(
              "flex min-w-0 max-w-full items-center gap-1.5 truncate rounded px-1 py-0.5 text-xs text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss data-[state=open]:text-ink",
              className,
            )}
          >
            {segments.map((segment, index) => (
              <Fragment key={index}>
                {index > 0 && <span aria-hidden>·</span>}
                {segment}
              </Fragment>
            ))}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80">
          <p className="mb-2 text-xs font-medium text-ink">Background work</p>
          {own.length > 0 && <ManageList items={own} now={now} canCancel={canCancel} onCancel={ask} label="This thread" />}
          {other.length > 0 && (
            <>
              <p className={cn("mb-2 text-xs text-muted", own.length > 0 && "mt-3")}>In other threads</p>
              <ManageList items={other} now={now} canCancel={canCancel} onCancel={ask} label="In other threads" />
            </>
          )}
        </PopoverContent>
      </Popover>
      {dialog}
    </>
  );
}

/**
 * The thread context card's "Background work" section: every active item
 * of this thread, with its state, its time, and a Cancel when the person
 * may stop it. The first event waiter also names what feeds the thread:
 * the listeners and routines that deliver into it (spec Part G), as a
 * "Fed by" line under its entry. The line names the thread's feeders, so
 * it shows once per thread, however many event waiters the thread holds.
 * Renders nothing while the thread has no background work.
 */
export function BackgroundWorkSection({
  sessionId,
  threadId,
  canCancel,
}: {
  sessionId: string;
  threadId: string;
  canCancel: boolean;
}) {
  const { data } = useSessionWakeups(sessionId);
  const { own } = splitByThread(backgroundItems(data), threadId);
  const now = useNow(own.length > 0);
  const { ask, dialog } = useBackgroundWorkCancel(sessionId);
  // The feeders read names what delivers into this thread (spec Part G): a
  // rule's own thread, an existing pin, or a subject thread. It only matters
  // next to the event waiter it explains, so it stays disabled otherwise.
  const feeders = useThreadFeeders(sessionId, threadId, { enabled: own.some((item) => item.kind === "event") });
  const feedById = own.find((item) => item.kind === "event")?.id;
  if (own.length === 0) return <>{dialog}</>;
  return (
    <section aria-label="Background work" className="border-t border-line py-3">
      <h2 className="mb-2 font-medium text-muted">Background work</h2>
      <ul>
        {own.map((item) => {
          const event = item.kind === "event" ? eventSectionDetail(item, now) : null;
          return (
            <li key={item.id} className="flex w-full min-w-0 items-start gap-2.5 py-1.5 text-sm text-muted">
              <KindIcon kind={item.kind} className="mt-0.5 h-4 w-4 text-ink" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-ink" title={item.reason}>{item.reason}</p>
                {event ? (
                  <>
                    <p className="text-xs" title={itemTimeTitle(item)}>
                      {item.subjectUrl ? (
                        <a href={item.subjectUrl} target="_blank" rel="noreferrer" className="text-moss hover:underline">{event.label}</a>
                      ) : (
                        event.label
                      )}
                      {[event.clauses, event.deadline].filter((part): part is string => part !== undefined).map((part) => ` · ${part}`)}
                    </p>
                    {item.id === feedById && <FeedByLine feeders={feeders.data} />}
                  </>
                ) : (
                  <p className="text-xs" title={itemTimeTitle(item)}>{sectionDetail(item, now)}</p>
                )}
              </div>
              {canCancel && (
                <Button variant="ghost" size="sm" className="shrink-0" onClick={() => ask(item)} aria-label={`Cancel ${item.reason}`}>
                  Cancel
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {dialog}
    </section>
  );
}

/**
 * The thread list's quiet line under a thread that waits on a timer:
 * "Waiting · next wakeup in 26m". The exact fire time shows on hover.
 */
export function ThreadTimerLine({ fireAt, className }: { fireAt: number; className?: string }) {
  const now = useNow(true);
  return (
    <Tooltip content={`Fires ${formatWhen(fireAt)}`}>
      <p className={cn("truncate text-[11px] leading-4 text-muted", className)}>
        Waiting · next wakeup {timeUntil(fireAt, now)}
      </p>
    </Tooltip>
  );
}

/**
 * The thread list's quiet line under a thread that waits on an event:
 * "Waiting on <subject label>", plus "+N more" when the thread has other
 * event waits (spec Part H).
 */
export function ThreadEventLine({ label, moreCount = 0, className }: { label: string; moreCount?: number; className?: string }) {
  return (
    <p className={cn("truncate text-[11px] leading-4 text-muted", className)}>
      {moreCount > 0 ? `Waiting on ${label} +${moreCount} more` : `Waiting on ${label}`}
    </p>
  );
}
