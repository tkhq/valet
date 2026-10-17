import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Workflow } from "lucide-react";
import type { Message, MessageSignal } from "@valet/api/wire";
import { Badge } from "~/components/primitives";
import { Markdown } from "~/components/markdown";
import { cn } from "~/lib/cn";

const BODY_PREVIEW_LEN = 200;
/** A signal body past either limit starts collapsed. */
const LONG_BODY_CHARS = 600;
const LONG_BODY_LINES = 8;

/** Pure: whether a signal body is long enough to start collapsed. */
export function isLongBody(text: string): boolean {
  return text.length > LONG_BODY_CHARS || text.split("\n").length > LONG_BODY_LINES;
}

/** Pure: first ~`max` chars of `text`, with an ellipsis when truncated. */
export function truncateBody(text: string, max = BODY_PREVIEW_LEN): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}…`;
}

/** Pure: child card title — `attributes.title`, falling back to the child id. */
export function childCardTitle(signal: MessageSignal): string {
  return signal.attributes?.title || signal.senderSessionId || "child runtime";
}

/**
 * Signal cards (assistant-centered web UI, decision 3): a wire message
 * carrying `signal` renders as a card, never a user bubble.
 * `signalType === "child.settled"` gets a dedicated child card; everything
 * else gets a generic labeled envelope. Both carry the moss left rail —
 * "events from the world look categorically different from typed
 * messages."
 *
 * `message.signal` must be set — callers (MessageList) are responsible for
 * only routing signal-bearing messages here.
 */
export function SignalCard({
  message,
  onOpenChild,
}: {
  message: Message;
  onOpenChild?: (childSessionId: string) => void;
}) {
  const signal = message.signal;
  if (!signal) return null;

  if (signal.signalType === "child.settled") {
    return <ChildSettledCard message={message} signal={signal} onOpenChild={onOpenChild} />;
  }
  return <EnvelopeCard message={message} signal={signal} />;
}

function CardShell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-4 my-3 rounded-md border border-line border-l-2 border-l-moss bg-paper px-4 py-3">
      {children}
    </div>
  );
}

function ChildSettledCard({
  message,
  signal,
  onOpenChild,
}: {
  message: Message;
  signal: MessageSignal;
  onOpenChild?: (childSessionId: string) => void;
}) {
  const title = childCardTitle(signal);
  const outcome = signal.attributes?.outcome;
  const preview = truncateBody(message.content);
  const childId = signal.senderSessionId;

  const body = (
    <CardShell>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-ink truncate">{title}</span>
        {outcome && <OutcomeBadge outcome={outcome} />}
      </div>
      {preview && <p className="mt-1.5 text-sm text-muted whitespace-pre-wrap">{preview}</p>}
    </CardShell>
  );

  if (!childId) return body;

  if (onOpenChild) {
    return (
      <button
        type="button"
        onClick={() => onOpenChild(childId)}
        className="block w-full text-left hover:bg-ink-wash rounded-md transition-colors"
      >
        {body}
      </button>
    );
  }

  return (
    <Link
      to="/sessions/$sessionId"
      params={{ sessionId: childId }}
      className="block hover:bg-ink-wash rounded-md transition-colors"
    >
      {body}
    </Link>
  );
}

/** Workflow operations stay compact; expansion preserves the complete report. */
function WorkflowRequestCard({ message, signal }: { message: Message; signal: MessageSignal }) {
  const runId = signal.attributes?.runId;
  const outcome = signal.attributes?.outcome;
  return (
    <div className="mx-auto my-2 w-full min-w-0 max-w-[52rem] px-5 sm:px-8">
      <div className="relative">
        <details className="group rounded-md border border-line border-l-2 border-l-moss bg-paper text-sm">
          <summary className={`flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-xs text-muted hover:text-ink [&::-webkit-details-marker]:hidden ${runId ? "pr-24" : ""}`}>
            <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" />
            <Workflow aria-hidden className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate font-medium">{signal.signalType === "workflow.settled" ? "Workflow result" : "Workflow request"}</span>
            {outcome && <OutcomeBadge outcome={outcome} />}
          </summary>
          <div className="border-t border-line px-3 py-3 text-ink">
            {message.content ? <Markdown>{message.content}</Markdown> : <p className="text-muted">No report text.</p>}
          </div>
        </details>
        {runId && <Link to="/workflows/runs/$runId" params={{ runId }}
          className="absolute right-3 top-1.5 text-xs leading-4 text-muted hover:underline">Open run</Link>}
      </div>
    </div>
  );
}

const WAKEUP_PREFIXES = ["process.", "watch.", "timer.", "lease.", "event."];

/**
 * Pure: whether a signal reports background work (spec 2026-10-08, B6;
 * 2026-10-15, Part H): `process.*`, `watch.*`, `timer.*`, `lease.*`, or
 * `event.*` with a wakeup or lease id. The wire does not ship the envelope
 * tag, so the id attribute marks the signal as the WakeWatcher's or a
 * human cancel's.
 */
export function isWakeupSignal(signal: MessageSignal): boolean {
  const attrs = signal.attributes ?? {};
  return (
    WAKEUP_PREFIXES.some((p) => signal.signalType.startsWith(p)) &&
    (attrs.wakeupId !== undefined || attrs.leaseId !== undefined)
  );
}

/** The words a wakeup signal's `cause` shows as (fix wave 4, L3). An unknown cause shows as sent. */
const CAUSE_LABEL: Record<string, string> = {
  pid_missing: "process not found",
  sandbox_unavailable: "sandbox stopped",
  rate: "too many events",
  deadline: "deadline reached",
  cancelled: "cancelled",
  delivered: "arrived as a message",
};

/**
 * Pure: the outcome badge of a wakeup signal, or null when it reports no
 * end. A clean exit is `success`. A person's cancel is `neutral`: it is a
 * choice, not a failure. A once waiter whose event arrived in its thread
 * as a message (`delivered`) is `success`. Every other end is `danger`.
 */
export function wakeupOutcome(
  attrs: Record<string, string>,
): { label: string; tone: "success" | "danger" | "neutral" } | null {
  const { cause, exitCode } = attrs;
  if (cause === undefined && exitCode === undefined) return null;
  if (cause === undefined || cause === "exit") {
    return { label: `exit ${exitCode ?? "?"}`, tone: exitCode === "0" ? "success" : "danger" };
  }
  const words = CAUSE_LABEL[cause] ?? cause;
  return {
    label: exitCode !== undefined ? `${words} · exit ${exitCode}` : words,
    tone: cause === "cancelled" ? "neutral" : cause === "delivered" ? "success" : "danger",
  };
}

/** Pure: who stopped the work, from `cancelledBy` (`user:<id>`), or null. */
export function cancelledByLabel(attrs: Record<string, string>): string | null {
  const by = attrs.cancelledBy;
  if (!by) return null;
  return by.startsWith("user:") ? "by a person" : `by ${by}`;
}

/** Pure: a duration in seconds as "45s", "12m", "3h 4m", or "2d 1h". */
export function formatDurationSeconds(raw: string | undefined): string | undefined {
  const s = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(s) || s < 0) return undefined;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

const CHANNEL_LABEL: Record<string, string> = {
  slack: "Slack",
  telegram: "Telegram",
  github: "GitHub",
  web: "the web app",
};

/** Pure: "from Slack" for a signal that carries its channel origin, else null. */
export function originLabel(signal: MessageSignal): string | null {
  const type = signal.origin?.channelType;
  if (!type) return null;
  return `from ${CHANNEL_LABEL[type] ?? type}`;
}

/** One digest block of an `event.matched` signal body: a key, an optional status and actor, a summary, and an optional URL and text. */
export interface EventDigestBlock {
  key: string;
  status?: string;
  actor?: string;
  summary: string;
  url?: string;
  text?: string;
}

/** A digest block's key, e.g. `github.check_run.completed` (fix round 1: distinguishes a new block from a blank line inside a digest's own text). */
const DIGEST_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
/** A digest's or block's link: `http(s)://` only (fix round 1, H3) — a `javascript:` URL renders as inert text. */
const DIGEST_URL_PATTERN = /^https?:\/\//i;

/**
 * Pure: whether `line` looks like a digest block's header (`digestHeader`
 * in `wake-watcher-decide.ts`): a dotted event key, then optionally a
 * status, then optionally `by <actor>`.
 */
function looksLikeDigestHeader(line: string): boolean {
  const parts = line.split(" · ");
  if (parts.length === 0 || parts.length > 3) return false;
  const key = parts[0];
  if (key === undefined || !DIGEST_KEY_PATTERN.test(key)) return false;
  if (parts.length === 3 && !(parts[2] ?? "").startsWith("by ")) return false;
  return true;
}

/**
 * Pure: a digest text line without its `> ` quote (spec Part F: every text
 * line is quoted, so it cannot read as a header). An unquoted line, from a
 * signal stored before quoting, stays as it is.
 */
function unquote(line: string): string {
  if (line.startsWith("> ")) return line.slice(2);
  return line === ">" ? "" : line;
}

function parseDigestBlock(lines: string[]): EventDigestBlock {
  const headerParts = (lines[0] ?? "").split(" · ");
  const key = headerParts[0] ?? "";
  let status: string | undefined;
  let actor: string | undefined;
  for (const part of headerParts.slice(1)) {
    if (part.startsWith("by ")) actor = part.slice(3);
    else status = part;
  }
  const summary = lines[1] ?? "";
  const rest = lines.slice(2);
  const url = rest[0] !== undefined && DIGEST_URL_PATTERN.test(rest[0]) ? rest[0] : undefined;
  const text = (url !== undefined ? rest.slice(1) : rest).map(unquote).join("\n");
  return {
    key,
    ...(status !== undefined ? { status } : {}),
    ...(actor !== undefined ? { actor } : {}),
    summary,
    ...(url !== undefined ? { url } : {}),
    ...(text !== "" ? { text } : {}),
  };
}

/**
 * Pure: parses an `event.matched` signal body into its digest blocks
 * (spec Part F, `eventMatchedSignal`/`digestBlock`). Each block's header
 * is `<key> · <status> · by <actor>`, then a summary line, an optional
 * URL, then optional text. A new block starts only at a blank line
 * followed by another header line (fix round 1) — a digest's own text
 * may itself contain a blank line (e.g. a multi-paragraph Slack message)
 * without splitting into a bogus second block. Once mode's extra digests
 * come back after an `Also matched:` line, one per digest, and are not
 * full blocks.
 */
export function parseEventMatchedBody(body: string): { blocks: EventDigestBlock[]; alsoMatched: string[] } {
  const lines = body.split("\n");
  const blocks: EventDigestBlock[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) blocks.push(parseDigestBlock(current));
    current = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === "") {
      const next = lines[i + 1];
      if (next === "Also matched:") {
        flush();
        return { blocks, alsoMatched: lines.slice(i + 2).filter((l) => l !== "") };
      }
      if (next !== undefined && looksLikeDigestHeader(next)) {
        flush();
        i += 1;
        continue;
      }
    }
    current.push(line);
    i += 1;
  }
  flush();
  return { blocks, alsoMatched: [] };
}

function optionalString(rec: Record<string, unknown>, key: string): string | undefined {
  const value = rec[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Pure: the `digests` attribute of an `event.matched` signal (spec Part
 * F), a JSON array of `{ key, status?, actor?, summary, url? }` with no
 * text. Null when it is absent or unreadable, so the caller parses the
 * body instead. A URL that is not `http(s)://` is left out.
 */
export function parseEventDigestsAttribute(raw: string | undefined): EventDigestBlock[] | null {
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: EventDigestBlock[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    // Narrowed to a non-null, non-array object above; each field is checked below.
    const rec = item as Record<string, unknown>;
    const key = optionalString(rec, "key");
    const summary = optionalString(rec, "summary");
    if (key === undefined || summary === undefined) return null;
    const status = optionalString(rec, "status");
    const actor = optionalString(rec, "actor");
    const url = optionalString(rec, "url");
    out.push({
      key,
      ...(status !== undefined ? { status } : {}),
      ...(actor !== undefined ? { actor } : {}),
      summary,
      ...(url !== undefined && DIGEST_URL_PATTERN.test(url) ? { url } : {}),
    });
  }
  return out;
}

/**
 * Pure: the digest blocks and `Also matched` lines an `event.matched`
 * card shows. With a readable `digests` attribute, the blocks come from
 * it, and each takes its text from the body block at the same position
 * when that block has the same key. Otherwise the body parser decides.
 */
export function eventMatchedView(body: string, digestsAttribute: string | undefined): { blocks: EventDigestBlock[]; alsoMatched: string[] } {
  const parsed = parseEventMatchedBody(body);
  const structured = parseEventDigestsAttribute(digestsAttribute);
  if (!structured) return parsed;
  const blocks = structured.map((entry, index) => {
    const fromBody = parsed.blocks[index];
    const text = fromBody?.key === entry.key ? fromBody.text : undefined;
    return text !== undefined ? { ...entry, text } : entry;
  });
  return { blocks, alsoMatched: parsed.alsoMatched };
}

/**
 * An `event.matched` signal (spec Part H): each digest block shows its
 * key, a status chip, the actor, the summary, and a link. A stream
 * signal lists every digest it carries; a once-mode signal lists the
 * extra digests it caught under "Also matched".
 */
function EventMatchedCard({ message, signal }: { message: Message; signal: MessageSignal }) {
  const attrs = signal.attributes ?? {};
  const origin = originLabel(signal);
  const { blocks, alsoMatched } = eventMatchedView(message.content, attrs.digests);
  return (
    <CardShell>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-ink">{attrs.subject || "Event matched"}</span>
        <Badge variant="neutral">event.matched</Badge>
        {origin && <span className="text-xs text-muted">{origin}</span>}
      </div>
      <ul className="mt-1.5 space-y-2">
        {blocks.map((block, index) => (
          <li key={index} className="text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 truncate font-medium text-ink">{block.key}</span>
              {block.status && <Badge variant="neutral">{block.status}</Badge>}
              {block.actor && <span className="text-xs text-muted">by {block.actor}</span>}
            </div>
            <p className="text-muted">{block.summary}</p>
            {block.url && (
              <a href={block.url} target="_blank" rel="noopener noreferrer" className="break-all text-xs text-moss hover:underline">
                {block.url}
              </a>
            )}
            {block.text && <p className="text-xs text-muted whitespace-pre-wrap">{block.text}</p>}
          </li>
        ))}
      </ul>
      {alsoMatched.length > 0 && (
        <div className="mt-1.5 text-xs text-muted">
          <p>Also matched:</p>
          {alsoMatched.map((line, index) => <p key={index}>{line}</p>)}
        </div>
      )}
    </CardShell>
  );
}

/**
 * Background work: the reason as the title, the outcome, and the log as
 * plain text. The WakeWatcher's event signals carry no `reason`, so their
 * title falls back to the `subject` (spec Part F/H), e.g. `event.ended`. A
 * person's cancel of an event wait carries the reason.
 */
function WakeupCard({ message, signal }: { message: Message; signal: MessageSignal }) {
  const attrs = signal.attributes ?? {};
  const outcome = wakeupOutcome(attrs);
  const cancelledBy = cancelledByLabel(attrs);
  const duration = formatDurationSeconds(attrs.durationSeconds);
  const origin = originLabel(signal);
  return (
    <CardShell>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-ink">{attrs.reason || attrs.subject || signal.signalType}</span>
        <Badge variant="neutral">{signal.signalType}</Badge>
        {outcome && <Badge variant={outcome.tone}>{outcome.label}</Badge>}
        {cancelledBy && <span className="text-xs text-muted">{cancelledBy}</span>}
        {duration && <span className="text-xs text-muted">ran {duration}</span>}
        {origin && <span className="text-xs text-muted">{origin}</span>}
      </div>
      {message.content && <LogBody content={message.content} />}
    </CardShell>
  );
}

/** One row of a transcript after watch events are grouped. */
export type TranscriptItem =
  | { kind: "message"; message: Message }
  | { kind: "watch"; events: Message[] };

function watchId(message: Message): string | undefined {
  const signal = message.signal;
  if (!signal || signal.signalType !== "watch.event" || !isWakeupSignal(signal)) return undefined;
  return signal.attributes?.wakeupId;
}

/** A turn that showed nothing: an assistant message with no text and no parts. */
function isQuietTurn(message: Message): boolean {
  return message.role === "assistant" && message.content.trim() === "" && message.parts.length === 0 && !message.signal;
}

/**
 * Pure: groups consecutive `watch.event` signals of one watch into one item
 * (spec Part G, fix wave 3). A quiet turn between two events of the same
 * watch joins the group, because it rendered nothing. A single event stays
 * a plain message. Any other message ends the group.
 */
export function groupWatchEvents(messages: readonly Message[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  let group: WatchGroup | null = null;
  for (const message of messages) {
    const id = watchId(message);
    if (group !== null && id !== undefined && group.id === id) {
      group.events.push(message);
      group.quiet = [];
      continue;
    }
    if (group !== null && isQuietTurn(message)) {
      group.quiet.push(message);
      continue;
    }
    flushGroup(out, group);
    group = null;
    if (id !== undefined) group = { id, events: [message], quiet: [] };
    else out.push({ kind: "message", message });
  }
  flushGroup(out, group);
  return out;
}

interface WatchGroup {
  id: string;
  events: Message[];
  /** Quiet turns after the last event, kept unless another event follows. */
  quiet: Message[];
}

function flushGroup(out: TranscriptItem[], group: WatchGroup | null): void {
  if (group === null) return;
  if (group.events.length > 1) out.push({ kind: "watch", events: group.events });
  else for (const message of group.events) out.push({ kind: "message", message });
  for (const message of group.quiet) out.push({ kind: "message", message });
}

/** Several events of one watch as one card: the latest event, and the rest on demand. */
export function WatchEventsCard({ events }: { events: Message[] }) {
  const [open, setOpen] = useState(false);
  const latest = events[events.length - 1];
  if (!latest?.signal) return null;
  const reason = latest.signal.attributes?.reason || "watch";
  const origin = originLabel(latest.signal);
  return (
    <CardShell>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-ink">{reason}</span>
        <Badge variant="neutral">watch.event</Badge>
        <span className="text-xs text-muted">{events.length} events</span>
        {origin && <span className="text-xs text-muted">{origin}</span>}
      </div>
      {open ? (
        events.map((event) => event.content && <LogBody key={event.id} content={event.content} />)
      ) : (
        latest.content && <LogBody content={latest.content} />
      )}
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="mt-1 text-xs text-muted hover:text-ink">
        {open ? "Show latest only" : `Show all ${events.length} events`}
      </button>
    </CardShell>
  );
}

/** A log tail: preformatted, never Markdown, so `#` and `***` lines stay text. */
function LogBody({ content }: { content: string }) {
  const long = isLongBody(content);
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1.5">
      <pre
        className={cn(
          "overflow-x-auto whitespace-pre-wrap break-words rounded-sm bg-ink-wash px-2 py-1.5 font-mono text-xs text-ink",
          long && !open && "max-h-32 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]",
        )}
      >
        {content}
      </pre>
      {long && (
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="mt-1 text-xs text-muted hover:text-ink">
          {open ? "Show less" : "Show full log"}
        </button>
      )}
    </div>
  );
}

function EnvelopeCard({ message, signal }: { message: Message; signal: MessageSignal }) {
  // A run's report (`workflow.request`) and its settle report back to the
  // thread that started it (`workflow.settled`, `run-attention.ts`).
  if (signal.signalType === "workflow.request" || signal.signalType === "workflow.settled") {
    return <WorkflowRequestCard key={message.id} message={message} signal={signal} />;
  }
  if (signal.signalType === "event.matched") {
    return <EventMatchedCard message={message} signal={signal} />;
  }
  if (isWakeupSignal(signal)) {
    return <WakeupCard message={message} signal={signal} />;
  }
  return (
    <CardShell>
      <span className="inline-flex items-center rounded-sm bg-neutral-100 px-1.5 py-0.5 text-[11px] font-medium tracking-wide text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
        {signal.signalType}
      </span>
      {message.content && <SignalBody content={message.content} />}
    </CardShell>
  );
}

/** A signal's text. A long one, such as a workflow's full prompt or a
 * fetched log, starts collapsed so it does not fill the thread. */
function SignalBody({ content }: { content: string }) {
  const long = isLongBody(content);
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1.5 text-sm text-ink">
      <div className={long && !open ? "max-h-32 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]" : undefined}>
        <Markdown>{content}</Markdown>
      </div>
      {long && (
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="mt-1 text-xs text-muted hover:text-ink">
          {open ? "Show less" : "Show full message"}
        </button>
      )}
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const isFailure = outcome === "failed" || outcome === "aborted";
  return <Badge variant={isFailure ? "danger" : "success"}>{outcome}</Badge>;
}
