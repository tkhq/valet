import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { recapWindow, writtenByOtherPerson } from "@valet/shared";
import type { ThreadRecapPoint, ThreadSummary } from "@valet/api/wire";
import { api } from "~/api/client";
import { useMarkThreadsRead } from "~/api/queries";
import type { StreamMessage } from "~/stores/stream";

/**
 * The recap a person sees when they open a thread that other people talked
 * to Valet in since their last visit. The card sits above the composer; the
 * transcript shows the "new" line before `anchorId`, the first message the
 * recap covers. The thread still opens at the newest message.
 */
export interface ThreadRecapView {
  /** Changes when the reader starts a new visit; a closed card stays closed only for its visit. */
  key: string;
  anchorId: string;
  mode: "away" | "first";
  /** The other people who wrote, for the card's heading. */
  people: string;
  /** The "new" line text. Absent for a first visit, which has no earlier part to set apart. */
  divider?: string;
  /** Absent while the recap loads, when it failed, and when the window reads at a glance. */
  points?: ThreadRecapPoint[];
}

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/** True while the page is on screen. A background tab must not mark threads read. */
function usePageVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible", () => true);
}

const DAY = 24 * 60 * 60_000;

/** "3:45 PM" today, "yesterday", a weekday within the week, else "Oct 3". */
export function recapSinceLabel(since: number, now = Date.now()): string {
  const at = new Date(since);
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  if (since >= midnight.getTime()) return at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (since >= midnight.getTime() - DAY) return "yesterday";
  if (since >= midnight.getTime() - 6 * DAY) return at.toLocaleDateString(undefined, { weekday: "long" });
  return at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * The open thread's recap, and its read marking. The thread is marked read
 * while the page is visible, when it opens and when a message lands, so a
 * background tab leaves new messages for the recap. The reader's last read
 * time is kept when the thread opens, before that marking moves it.
 */
export function useThreadRecap({ threadId, thread, messages, viewerId }: {
  threadId?: string;
  /** The open thread's list row: its `readAt` is the reader's last visit. */
  thread?: Pick<ThreadSummary, "id" | "sessionId" | "readAt">;
  messages: StreamMessage[];
  viewerId?: string;
}): ThreadRecapView | undefined {
  const pageVisible = usePageVisible();
  const [visit, setVisit] = useState<{ threadId: string; readAt?: number; count: number }>();
  if (thread && thread.id === threadId && visit?.threadId !== thread.id) {
    setVisit({ threadId: thread.id, readAt: thread.readAt, count: 0 });
  }

  const threadMessages = useMemo(() => messages.filter((message) => message.threadId === threadId), [messages, threadId]);
  const latestRef = useRef({ threadMessages, viewerId });
  latestRef.current = { threadMessages, viewerId };
  // A reader who left the tab on this thread starts a new visit on return
  // when another person wrote while it was hidden.
  const hiddenAtRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!pageVisible) {
      hiddenAtRef.current = Date.now();
      return;
    }
    const hiddenAt = hiddenAtRef.current;
    hiddenAtRef.current = undefined;
    const { threadMessages: current, viewerId: reader } = latestRef.current;
    if (hiddenAt === undefined || !threadId || !reader) return;
    if (!current.some((message) => message.createdAt > hiddenAt && writtenByOtherPerson(message, reader))) return;
    setVisit((previous) => previous?.threadId === threadId ? { threadId, readAt: hiddenAt, count: previous.count + 1 } : previous);
  }, [pageVisible, threadId]);

  const markRead = useMarkThreadsRead(thread?.sessionId ?? "");
  const markReadMutate = markRead.mutate;
  const latestAt = threadMessages.reduce((latest, message) => Math.max(latest, message.createdAt), 0);
  const markedRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!pageVisible || !thread || thread.id !== threadId) return;
    if (thread.readAt !== undefined && thread.readAt >= latestAt) return;
    // One mark per newest message: a client clock behind the server's would
    // otherwise keep the optimistic read time below `latestAt` and repeat.
    const marker = `${thread.id}:${latestAt}`;
    if (markedRef.current === marker) return;
    markedRef.current = marker;
    markReadMutate({ threadIds: [thread.id] });
  }, [pageVisible, thread, threadId, latestAt, markReadMutate]);

  const span = useMemo(() => visit && visit.threadId === threadId && viewerId
    ? recapWindow(threadMessages, viewerId, visit.readAt)
    : null, [visit, threadId, viewerId, threadMessages]);
  // Another person's new message makes a new recap; Valet's own messages do not.
  const otherCount = span && viewerId ? span.messages.filter((message) => writtenByOtherPerson(message, viewerId)).length : 0;
  const recapQ = useQuery({
    queryKey: ["thread-recap", threadId, visit?.readAt ?? "first", visit?.count ?? 0, otherCount],
    queryFn: () => api.getThreadRecap(threadId ?? "", visit?.readAt),
    enabled: Boolean(threadId && span?.worthRecap),
    staleTime: Infinity,
    // A refreshed recap for the same visit replaces the shown one when it
    // arrives, instead of hiding the card meanwhile. Another thread's or
    // visit's recap never stands in.
    placeholderData: (previous, previousQuery) => {
      const key = previousQuery?.queryKey;
      return key && key[1] === threadId && key[2] === (visit?.readAt ?? "first") && key[3] === (visit?.count ?? 0) ? previous : undefined;
    },
    retry: false,
    refetchOnWindowFocus: false,
  });

  const anchor = span?.messages[0];
  if (!span || !anchor || !visit) return undefined;
  const people = span.people.length > 2 ? `${span.people.slice(0, 2).join(", ")} and others` : span.people.join(" and ");
  return {
    key: `${visit.threadId}:${visit.readAt ?? "first"}:${visit.count}`,
    anchorId: anchor.id,
    mode: span.mode,
    people,
    ...(span.mode === "away" && span.since !== undefined ? { divider: `New since ${recapSinceLabel(span.since)} · ${people}` } : {}),
    ...(span.worthRecap && recapQ.data?.recap ? { points: recapQ.data.recap.points } : {}),
  };
}

/** The "new" line the transcript shows before the recap's first message. */
export function NewSinceDivider({ label }: { label: string }) {
  return (
    <div data-testid="new-since-divider" className="px-5 pt-1 sm:px-8">
      <div className="mx-auto flex w-full max-w-3xl items-center gap-2 text-[11px] font-medium text-moss">
        <span className="h-px flex-1 bg-moss-wash-strong" aria-hidden />
        <span className="whitespace-nowrap">{label}</span>
        <span className="h-px flex-1 bg-moss-wash-strong" aria-hidden />
      </div>
    </div>
  );
}

/**
 * The recap card above the composer. It leaves when the reader closes it or
 * sends a message, which ends the visit.
 */
export function ThreadRecapDock({ recap }: { recap?: ThreadRecapView }) {
  const [closed, setClosed] = useState<string>();
  if (!recap?.points || closed === recap.key) return null;
  return (
    <section aria-label="Recap" data-testid="thread-recap" className="mx-auto mt-3 w-full min-w-0 max-w-[52rem] shrink-0 px-5 sm:px-8">
      <div className="flex items-start gap-2 rounded-xl border border-line bg-moss-wash px-3 py-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted">
            {recap.mode === "away" ? `While you were away · ${recap.people}` : "Where this stands"}
          </h3>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[13px] leading-5 marker:text-moss">
            {recap.points.map((point, index) => (
              <li key={index}>
                {point.forReader && <span className="font-semibold">Waiting on you: </span>}
                {point.text}
              </li>
            ))}
          </ul>
        </div>
        <button
          type="button"
          onClick={() => setClosed(recap.key)}
          className="rounded p-1 text-muted hover:text-ink"
          aria-label="Close recap"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
    </section>
  );
}
