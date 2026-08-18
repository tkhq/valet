/**
 * The session's Activity drawer: its log and the files it changed
 * (V1 ports #8 and #4).
 *
 * These sit in a drawer rather than in `SandboxTabs` because that tab strip
 * renders only for a `full`-profile session. Neither of these reads the
 * sandbox — the log is engine events and the file list is a stored diff —
 * so gating them on a sandbox profile would hide them exactly where they
 * are most useful: a headless assistant session, which is the surface most
 * people spend their day on.
 */
import { useEffect, useRef, useState } from "react";
import { ScrollText, X } from "lucide-react";
import type { ChangedFile, SessionLogEntry, SessionLogKind } from "@valet/api/wire";
import { useFilesChanged, useSessionLog } from "~/api/queries";
import { Button, Spinner, TabBar, tabPanelId } from "~/components/primitives";
import { formatWhen } from "~/lib/format-when";
import { cn } from "~/lib/cn";

export type ActivityTabId = "log" | "changes";

const TABS = [
  { id: "log" as const, label: "Log" },
  { id: "changes" as const, label: "Changes" },
];

const TABLIST_LABEL = "Session activity";

/** Colour per log kind. Errors are the only row that earns a warm colour —
 * everything else is reference text and must not compete with the
 * transcript beside it. */
const KIND_CLASS: Readonly<Record<SessionLogKind, string>> = {
  lifecycle: "text-muted",
  tool: "text-ink",
  turn: "text-muted",
  error: "text-danger-600 dark:text-danger-500",
};

export function ActivityPanel({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<ActivityTabId>("log");
  return (
    <aside
      className="w-80 shrink-0 border-l border-line bg-paper flex flex-col min-h-0"
      aria-label="Session activity"
    >
      <div className="flex items-center gap-2 px-3 pt-2">
        <div className="flex-1 min-w-0">
          <TabBar tabs={TABS} active={tab} onSelect={setTab} label={TABLIST_LABEL} />
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close activity">
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div
        id={tabPanelId(TABLIST_LABEL, tab)}
        role="tabpanel"
        aria-labelledby={`${tabPanelId(TABLIST_LABEL, tab)}-tab`}
        // Each panel owns its own scrolling. The log has to control its
        // scroll position to stay pinned to the newest row, which it cannot
        // do when the scroll container belongs to this wrapper.
        className="flex-1 min-h-0 flex flex-col"
      >
        {tab === "log" ? <SessionLog sessionId={sessionId} /> : <FilesChanged sessionId={sessionId} />}
      </div>
    </aside>
  );
}

// ── Log ───────────────────────────────────────────────────────────────────

/**
 * How close to the bottom still counts as "at the bottom", in pixels. A
 * reader who has scrolled up is reading history and must not be yanked back
 * when the next poll lands.
 */
const STICK_THRESHOLD_PX = 32;

export function SessionLog({ sessionId }: { sessionId: string }) {
  const log = useSessionLog(sessionId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const entries = log.data?.entries ?? [];
  const newestOffset = entries[entries.length - 1]?.offset;

  // Follow the newest row, the way V1's panel did. The rows are oldest
  // first, so without this the panel opens on the oldest event in the page
  // and never moves while the session works.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onScroll() {
      if (!el) return;
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
    }
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Keyed on the newest offset, not the row count: a poll can replace the
  // page with the same number of rows and still have moved forward.
  useEffect(() => {
    if (atBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [newestOffset]);

  if (log.isLoading) {
    return (
      <div className="grid place-items-center py-8 text-sm text-muted">
        <Spinner size={14} />
      </div>
    );
  }
  if (log.error) {
    return (
      <p className="p-4 text-xs text-danger-500">
        The log did not load. Check that the API is reachable, then reopen this panel.
      </p>
    );
  }

  if (entries.length === 0) {
    return (
      <p className="p-4 text-xs text-muted">
        Nothing yet. The log fills in as the agent starts its sandbox, calls tools, and finishes turns.
      </p>
    );
  }

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
      {/* Said BEFORE the rows, because it describes what sits above them.
          Without it a capped page reads as the session's whole history, and
          the retention line below would take the blame for the gap. */}
      {log.data?.hasOlder === true && (
        <p className="px-3 py-2 text-[10px] text-muted border-b border-line/60">
          This is the most recent activity. Earlier events are not in this page.
        </p>
      )}
      <ol className="divide-y divide-line/60">
        {entries.map((entry) => (
          <LogRow key={entry.offset} entry={entry} />
        ))}
      </ol>
      <p className="px-3 py-2 text-[10px] text-muted">
        The engine keeps {log.data?.retentionDays ?? 7} days of events. Anything older is deleted.
      </p>
    </div>
  );
}

export function LogRow({ entry }: { entry: SessionLogEntry }) {
  return (
    <li className="px-3 py-1.5">
      <div className="flex items-baseline gap-2">
        <span className={cn("text-xs truncate", KIND_CLASS[entry.kind])}>{entry.summary}</span>
        <time className="ml-auto shrink-0 text-[10px] tabular-nums text-muted" dateTime={new Date(entry.at).toISOString()}>
          {formatWhen(entry.at)}
        </time>
      </div>
      {entry.detail !== undefined && (
        <div className="text-[11px] font-mono text-muted truncate" title={entry.detail}>
          {entry.detail}
        </div>
      )}
    </li>
  );
}

// ── Files changed ─────────────────────────────────────────────────────────

export function FilesChanged({ sessionId }: { sessionId: string }) {
  const changed = useFilesChanged(sessionId);

  if (changed.isLoading) {
    return (
      <div className="grid place-items-center py-8 text-sm text-muted">
        <Spinner size={14} />
      </div>
    );
  }
  if (changed.error) {
    return (
      <p className="p-4 text-xs text-danger-500">
        The file list did not load. Check that the API is reachable, then reopen this panel.
      </p>
    );
  }

  const data = changed.data;
  // The server says WHY the list is empty. Showing that beats an empty
  // table, which reads as "this session changed nothing" when the truth is
  // usually "this session has no repository".
  if (data === undefined || data.files.length === 0) {
    return (
      <p className="p-4 text-xs text-muted">
        {data?.unavailableMessage ?? "No file changes to show."}
      </p>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {/* The list is a snapshot of one settled turn, so it carries the time
          it was taken. Without that a reader takes it for a live read. */}
      <p className="px-3 py-2 text-[11px] text-muted border-b border-line/60">
        {data.files.length} {data.files.length === 1 ? "file" : "files"}
        {" · "}
        <span className="text-moss">+{data.additions}</span>{" "}
        <span className="text-danger-600 dark:text-danger-500">-{data.deletions}</span>
        {data.capturedAt !== undefined && ` · as of ${formatWhen(data.capturedAt)}`}
        {data.truncated && " · counts are a floor: the stored diff hit its size cap"}
      </p>
      {data.stale === true && data.staleMessage !== undefined && (
        <p className="px-3 py-2 text-[11px] text-danger-600 dark:text-danger-500 border-b border-line/60">
          {data.staleMessage}
        </p>
      )}
      <ul className="divide-y divide-line/60">
        {data.files.map((file) => (
          <ChangedFileRow key={file.path} file={file} />
        ))}
      </ul>
    </div>
  );
}

/** The file name — the part of a path a reader scans for. */
export function baseName(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/** The directory the file sits in, or "." at the repository root. */
export function dirName(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "." : path.slice(0, cut);
}

/** The label for a file's kind of change, for the row's title text. */
function statusLabel(file: ChangedFile): string {
  if (file.status === "renamed" && file.previousPath !== undefined) {
    return `renamed from ${file.previousPath}`;
  }
  return file.status;
}

export function ChangedFileRow({ file }: { file: ChangedFile }) {
  return (
    <li className="px-3 py-1.5" title={`${file.path} — ${statusLabel(file)}`}>
      <div className="flex items-baseline gap-2">
        {/* Truncating a path from the right hides the file name, which is
            the half a reader scans for. The row shows the name and keeps the
            directory as a second line. */}
        <span className="text-[11px] font-mono truncate text-ink">{baseName(file.path)}</span>
        <span className="ml-auto shrink-0 text-[10px] tabular-nums">
          {file.binary ? (
            <span className="text-muted">binary</span>
          ) : (
            <>
              <span className="text-moss">+{file.additions}</span>{" "}
              <span className="text-danger-600 dark:text-danger-500">-{file.deletions}</span>
            </>
          )}
        </span>
      </div>
      <div className="text-[10px] text-muted truncate">
        {dirName(file.path)}
        {file.status !== "modified" && ` · ${statusLabel(file)}`}
      </div>
    </li>
  );
}

/** The header control that opens the drawer. */
export function ActivityToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onToggle}
      aria-label="Activity"
      aria-pressed={open}
      title="Session log and changed files"
    >
      <ScrollText className="h-4 w-4" />
    </Button>
  );
}
