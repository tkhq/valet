import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Workflow } from "lucide-react";
import type { Message, MessageSignal } from "@valet/api/wire";
import { Badge } from "~/components/primitives";
import { Markdown } from "~/components/markdown";

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

function EnvelopeCard({ message, signal }: { message: Message; signal: MessageSignal }) {
  // A run's report (`workflow.request`) and its settle report back to the
  // thread that started it (`workflow.settled`, `run-attention.ts`).
  if (signal.signalType === "workflow.request" || signal.signalType === "workflow.settled") {
    return <WorkflowRequestCard key={message.id} message={message} signal={signal} />;
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
