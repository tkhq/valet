import { AlertCircle, Braces, ChevronRight, FileText, GitBranch, Lock, Pencil, Reply } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { classifyProviderFailure, providerFailureSummary } from "@valet/shared";
import type {
  MessagePart,
  MessageSkillInvocation,
  PromptImageAttachment,
  PromptFileAttachment,
  MessageReplyReference,
} from "@valet/api/wire";
import type { SettledOutcome, StreamMessage } from "~/stores/stream";
import { Markdown } from "~/components/markdown";
import { CodeBlock } from "~/components/code-block";
import { CopyButton } from "./tool-renderers/tool-shell";
import { ToolCallBlock } from "./tool-call-block";
import { ReasoningLine, segmentParts, withExtraWork, WorkGroup, workKey, type WorkPart } from "./work-group";
import { extractSkillInvocation, type SkillBlock } from "./tool-renderers/skill";
import { cn } from "~/lib/cn";
import { shortModelLabel } from "~/lib/models";
import { useRateMessage, useSessionRatings } from "~/api/queries";
import { RatingButtons } from "./rating-buttons";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Tooltip } from "~/components/primitives";

/** Message actions show on hover, and always at phone width, where there is no hover. */
const ROW_ACTION = "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 max-sm:opacity-100";

/**
 * Per-message 👍/👎 (TKAI-334): finer-grained than the session-level rating
 * in the header — "turn 3 was bad" data, not the primary eval signal.
 * Hidden until hover unless a rating is set (mirrors the copy button).
 */
function MessageRating({ message }: { message: StreamMessage }) {
  const ratings = useSessionRatings(message.sessionId);
  const rate = useRateMessage(message.sessionId);
  const value = ratings.data?.entries[message.id] ?? null;
  return (
    <RatingButtons
      subject="reply"
      value={value}
      disabled={rate.isPending}
      onRate={(rating) =>
        rate.mutate({ entryId: message.id, threadId: message.threadId ?? undefined, rating })
      }
      className={cn(
        "opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity max-sm:opacity-100",
        value !== null && "opacity-100",
      )}
    />
  );
}

/**
 * `text_delta` replaces only the active message object, but MessageList must
 * still render to follow the stream. Memoizing at this stable prop boundary
 * keeps every unchanged history row from rebuilding its Markdown tree.
 */
export const MessageItem = memo(function MessageItem({
  message,
  suppressEmptyPlaceholder = false,
  viewerId,
  onReply,
  onEdit,
  onBranch,
  onBranchPrivately,
  dimmed = false,
  ratings = true,
  readOnly = false,
  continuation = false,
  absorbedLeading = 0,
  extraWork,
  extraWorkLive = false,
  workedForMs,
}: {
  message: StreamMessage;
  /** Leading parts the row above shows in its own work line (`MessageList`). */
  absorbedLeading?: number;
  /** Quiet calls from the next messages of this turn, shown in this row's last work line. */
  extraWork?: WorkPart[];
  /** The agent is still adding to `extraWork`. */
  extraWorkLive?: boolean;
  /** How long the turn ran, shown after its last reply. */
  workedForMs?: number;
  /** Puts this message back in the composer to edit. Set only when the viewer may edit it. */
  onEdit?: (message: StreamMessage) => void;
  /** Copies the conversation up to this message into a new thread. */
  onBranch?: (message: StreamMessage) => void;
  /** Copies it into the viewer's private threads instead. Set in a team thread only. */
  onBranchPrivately?: (message: StreamMessage) => void;
  /** An edit in progress replaces this row. */
  dimmed?: boolean;
  /** The same assistant turn as the row above: no repeated author, time,
   *  and model line. A reply's actions move under its text. */
  continuation?: boolean;
  /** True for the last message while the agent is mid-turn — an empty
   *  assistant row is then a streaming placeholder, not a failed turn. */
  suppressEmptyPlaceholder?: boolean;
  /** The signed-in user's id — see `MessageList`'s prop doc. */
  viewerId?: string;
  /** Selects a completed assistant text message as the composer reply target. */
  onReply?: (target: MessageReplyReference) => void;
  /** The per-reply rating buttons; see `MessageList`'s prop doc. */
  ratings?: boolean;
  /** Historical previews show receipts without message actions or interactive tool renderers. */
  readOnly?: boolean;
}) {
  if (isEmptyInterruption(message)) return null;
  const fyi = fyiText(message);
  if (fyi) return <FyiLine id={message.id} text={fyi} createdAt={message.createdAt} />;
  const isUser = message.role === "user";
  const collapseStructured = message.role === "assistant" && message.completed === true &&
    message.stopReason !== "error" && !message.settledOutcome;
  const copyText = messageCopyText(message);
  const segments = readOnly
    ? message.parts.map(part => ({ kind: "part" as const, part }))
    : withExtraWork(segmentParts(message.parts.slice(absorbedLeading)), extraWork);
  // Defined only for another member's message on a shared session; the
  // viewer's own messages (and authorless rows) keep the "You" treatment.
  const teammate = isUser ? senderLabel(message.author, viewerId) : undefined;
  const actions = readOnly ? null : <>
    {message.role === "assistant" && message.completed === true && copyText && onReply && (
      <button
        type="button"
        onClick={() => onReply({ messageId: message.id, excerpt: replyExcerpt(copyText) })}
        className="inline-flex h-[22px] items-center gap-1 rounded px-1.5 text-xs leading-none text-muted/70 opacity-0 transition-opacity hover:bg-ink-wash hover:text-[--fg] group-hover:opacity-100 focus:opacity-100 max-sm:min-h-11 max-sm:opacity-100"
        aria-label="Reply to message"
      >
        <Reply className="h-3.5 w-3.5" aria-hidden />
        Reply
      </button>
    )}
    {ratings && message.role === "assistant" && <MessageRating message={message} />}
    {onEdit && (
      <Tooltip content="Edit message">
        <Button variant="ghost" size="icon" aria-label="Edit message" className={ROW_ACTION} onClick={() => onEdit(message)}>
          <Pencil className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </Tooltip>
    )}
    {copyText && (
      <CopyButton
        getText={() => copyText}
        label="Copy message"
        className="inline-flex items-center justify-center opacity-0 group-hover:opacity-100 max-sm:opacity-100 max-sm:min-h-11 max-sm:min-w-11"
      />
    )}
    {onBranch && !onBranchPrivately && (
      <Tooltip content="Branch into a new thread">
        <Button variant="ghost" size="icon" aria-label="Branch into a new thread" className={ROW_ACTION} onClick={() => onBranch(message)}>
          <GitBranch className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </Tooltip>
    )}
    {onBranch && onBranchPrivately && (
      <DropdownMenu>
        <Tooltip content="Branch into a new thread">
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Branch into a new thread" className={ROW_ACTION}>
              <GitBranch className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => onBranch(message)}><GitBranch aria-hidden />Branch for the team</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onBranchPrivately(message)}><Lock aria-hidden />Branch privately to me</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )}
  </>;
  return (
    <article
      data-message-id={message.id}
      aria-disabled={dimmed || undefined}
      className={cn("group min-w-0 px-5 sm:px-8 transition-opacity", continuation ? "pb-3" : "py-3", dimmed && "pointer-events-none opacity-40")}
    >
      {/* Row background spans full width; the content column is capped at a
          readable measure and centered — prose and tool cards both benefit. */}
      <div className={cn(
        "mx-auto flex w-full min-w-0 max-w-3xl justify-end"
      )}>

        <div className={cn("flex min-w-0 flex-1 flex-col gap-2", isUser && "sm:max-w-[85%] rounded-2xl bg-ink-wash px-4 py-3")}>
          {!continuation && (
            <div className={cn("text-xs text-muted flex min-w-0 flex-wrap items-center gap-2", !isUser && "max-sm:contents")}>
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium text-ink/80">
                  {isUser ? teammate ?? "You" : message.role === "assistant" ? "Assistant" : message.role}
                </span>
                <span>•</span>
                <span title={new Date(message.createdAt).toLocaleString()}>{formatTime(message.createdAt)}</span>
                {isUser && message.editOf && <span className="text-muted/80">edited</span>}
                {message.role === "assistant" && message.model && (
                  <span
                    className="hidden sm:inline font-mono text-[10px] text-muted opacity-80"
                    title={message.model}
                  >
                    {shortModelLabel(message.model)}
                  </span>
                )}
                {message.settledOutcome && <SettledBadge outcome={message.settledOutcome} />}
              </div>
              <div className={cn("ml-auto flex items-center gap-1", !isUser && "max-sm:order-2 max-sm:ml-0 max-sm:flex-wrap")}>{actions}</div>
            </div>
          )}
          <div className="space-y-2">
            {isUser && message.replyTo && (
              <blockquote className="rounded border-l-2 border-moss bg-moss-wash px-3 py-2 text-xs text-muted">
                <span className="font-medium text-ink">Replying to Assistant</span>
                <p className="mt-1 line-clamp-3">{message.replyTo.excerpt}</p>
              </blockquote>
            )}
            {isUser && message.attachments && message.attachments.length > 0 && (
              <UserAttachmentStrip attachments={message.attachments} />
            )}
            {message.parts.length === 0 && message.content && (
              <TextBlock text={message.content} skillMeta={isUser ? message.skill : undefined} detectSkill={isUser} collapseStructured={collapseStructured} />
            )}
            {segments.map((segment, i) => segment.kind === "work"
              // Work lines and tool cards hold per-mount state (open or
              // closed), so key them by a stable callId: an index key hands
              // one call's state to another whenever the parts shift.
              // Text parts are stateless and positional.
              ? <WorkGroup key={workKey(segment.parts, i)} parts={segment.parts}
                  live={i === segments.length - 1 && (message.completed === false || extraWorkLive)} readOnly={readOnly} />
              : <PartView
                  key={segment.part.kind === "tool_call" ? `tc-${segment.part.callId}` : `${segment.part.kind}-${i}`}
                  part={segment.part}
                  readOnly={readOnly}
                  skillMeta={isUser ? message.skill : undefined}
                  detectSkill={isUser}
                  collapseStructured={collapseStructured}
                />)}
            {!suppressEmptyPlaceholder && isEmptyAssistantMessage(message) && (message.errorMessage?.trim()
              ? <div role="alert" className="space-y-1 text-sm text-danger-600 dark:text-danger-500 [overflow-wrap:anywhere]">
                <p className="flex items-start gap-1.5">
                  <AlertCircle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{emptyReplyNotice(message)}</span>
                </p>
                <details className="pl-5 text-xs text-muted">
                  <summary className="cursor-pointer select-none">Details</summary>
                  <p className="mt-1 whitespace-pre-wrap">{message.errorMessage?.trim()}</p>
                </details>
              </div>
              : <p className="text-xs italic text-muted [overflow-wrap:anywhere]">{emptyReplyNotice(message)}</p>)}
            {workedForMs !== undefined && <p className="text-xs text-muted">Worked for {formatDuration(workedForMs)}</p>}
          </div>
          {/* A continuation has no header line, so a reply's actions sit
              under its text instead. A tool-only continuation has none. */}
          {continuation && copyText && (
            <div className="flex items-center justify-end gap-1 text-xs text-muted max-sm:flex-wrap max-sm:justify-start">{actions}</div>
          )}
        </div>
      </div>
    </article>
  );
});

/** The text of a one-line "FYI:" update from Valet: a note that needs nothing from the person. */
export function fyiText(message: StreamMessage): string | undefined {
  if (message.role !== "assistant" || message.completed !== true || message.stopReason === "error") return undefined;
  if (message.parts.some((part) => part.kind !== "text" && part.kind !== "thinking")) return undefined;
  const text = messageCopyText(message).trim();
  if (!/^FYI:/i.test(text) || text.length > 400 || text.includes("\n")) return undefined;
  return text.replace(/^FYI:\s*/i, "");
}

/** A quiet one-line update. Real replies keep the full message layout. */
function FyiLine({ id, text, createdAt }: { id: string; text: string; createdAt: number }) {
  return (
    <article data-message-id={id} className="min-w-0 px-5 py-1 sm:px-8">
      <p className="mx-auto flex w-full min-w-0 max-w-3xl items-baseline gap-2 text-sm text-muted">
        <span className="shrink-0 text-xs font-medium uppercase tracking-wide">FYI</span>
        <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
        <span className="ml-auto shrink-0 text-xs" title={new Date(createdAt).toLocaleString()}>{formatTime(createdAt)}</span>
      </p>
    </article>
  );
}

export function isEmptyInterruption(message: StreamMessage): boolean {
  return message.stopReason === "abort" && isEmptyAssistantMessage(message);
}

/**
 * A persisted assistant row with no parts and no content is what a turn
 * that died before its first token leaves behind (e.g. the provider
 * rejected the call — bad key, exhausted credits). Rendering it as a blank
 * bubble made those failures look like the product silently broke; name
 * the state instead. Exported for tests.
 */
export function isEmptyAssistantMessage(message: StreamMessage): boolean {
  return (
    message.role === "assistant" &&
    message.parts.length === 0 &&
    !message.content &&
    !message.signal
  );
}

/**
 * The line for an empty assistant reply. A failed turn gets one sentence that
 * names the cause and the next step. The provider's raw text, which REST
 * keeps after a reload, stays under Details. Other empty replies keep the
 * generic text.
 */
function emptyReplyNotice(message: StreamMessage): string {
  const error = message.errorMessage?.trim();
  if (!error) return "No response. Try again or choose another model.";
  return providerFailureSummary(classifyProviderFailure(error), modelProvider(message.model));
}

/** "openai/gpt-5.6" or "openai:gpt-5.6" → "openai". A bare id names no provider. */
function modelProvider(model: string | undefined): string | undefined {
  const match = model ? /^([^/:]+)[/:]/.exec(model) : null;
  return match?.[1];
}

/** "45s", "3m 12s", or "1h 4m": how long a turn ran. Exported for tests. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * The clipboard payload for a message's copy button: the visible prose —
 * text parts joined by blank lines, or the legacy `content` field when a
 * message has no parts. Thinking and tool-call parts stay out; the debug
 * transcript (session header) covers those. Empty string means no button.
 * Exported for tests.
 */
export function replyExcerpt(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const codepoints = Array.from(normalized);
  return codepoints.length <= 280
    ? normalized
    : codepoints.slice(0, 279).join("").trimEnd() + "…";
}

export function messageCopyText(message: StreamMessage): string {
  const texts = message.parts
    .filter((p): p is Extract<MessagePart, { kind: "text" }> => p.kind === "text")
    .map((p) => p.text.trim())
    .filter(Boolean);
  const raw = texts.length > 0 ? texts.join("\n\n") : (message.content?.trim() ?? "");
  // A skill-invocation user message displays as a card plus the typed
  // arguments — copying the raw multi-KB expansion would paste internal
  // markup that, re-sent, bypasses dispatch and persists the stale skill
  // body. Copy the re-sendable command form instead.
  if (message.role === "user" && raw) {
    const block = extractSkillInvocation(raw, message.skill);
    if (block) return `/skill:${block.name}${block.rest ? ` ${block.rest}` : ""}`;
  }
  return raw;
}

/**
 * The display label for a user message sent by someone OTHER than the
 * viewer — a teammate on a shared (team-owned) session. Returns undefined
 * for the viewer's own messages and for authorless rows (personal
 * sessions, optimistic rows, entries from before authors were stamped);
 * the caller renders those as "You". `||` (not `??`) so an empty-string
 * name still falls through to email. Exported for tests.
 */
export function senderLabel(
  author: StreamMessage["author"],
  viewerId: string | undefined,
): string | undefined {
  // A Slack sender with no Valet account runs as the person who set the rule
  // up; `externalSender` marks that the name, not that person, wrote it.
  if (!author || (author.id === viewerId && !author.externalSender)) return undefined;
  return author.name || author.email || "Teammate";
}

function PartView({
  part,
  skillMeta,
  detectSkill,
  collapseStructured,
  readOnly,
}: {
  readOnly?: boolean;
  part: MessagePart;
  skillMeta?: MessageSkillInvocation;
  detectSkill?: boolean;
  collapseStructured?: boolean;
}) {
  switch (part.kind) {
    case "text":
      return <TextBlock text={part.text} skillMeta={skillMeta} detectSkill={detectSkill} collapseStructured={collapseStructured} />;
    case "thinking":
      return <ReasoningLine part={part} live={false} />;
    case "tool_call":
      return <ToolCallBlock part={part} readOnly={readOnly} />;
  }
}

function TextBlock({
  text,
  skillMeta,
  detectSkill = false,
  collapseStructured = false,
}: {
  text: string;
  /** Wire skill stamp from the enclosing message (user messages only). */
  skillMeta?: MessageSkillInvocation;
  /** True only for user messages — the dispatcher writes skill blocks
   *  nowhere else, and assistant prose that quotes one must stay prose. */
  detectSkill?: boolean;
  collapseStructured?: boolean;
}) {
  // Memoized so streaming re-renders elsewhere in the thread don't re-run
  // the extraction on static user text every frame.
  const block = useMemo(
    () => (detectSkill ? extractSkillInvocation(text, skillMeta) : null),
    [text, skillMeta, detectSkill],
  );
  const structured = useMemo(
    () => collapseStructured ? structuredText(text) : null,
    [text, collapseStructured],
  );
  if (!text) return null;
  if (structured) return <StructuredTextCard result={structured} />;
  if (block) {
    return (
      <>
        <SkillInvocationBlock block={block} />
        {block.rest && <Markdown>{block.rest}</Markdown>}
      </>
    );
  }
  return <Markdown>{text}</Markdown>;
}

interface StructuredText {
  code: string;
  count: string;
  summary?: string;
}

function isStructuredDiagnostic(data: unknown): boolean {
  return data !== null && typeof data === "object" && (
    "error" in data || "errors" in data || ("ok" in data && data.ok === false) ||
    ("status" in data && (data.status === "failed" || data.status === "error"))
  );
}

/** Only complete JSON documents qualify. Prose and diagnostic output stay visible. */
function structuredText(text: string): StructuredText | null {
  if (text.length < 1500) return null;
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*)\n```$/.exec(trimmed);
  const json = fenced?.[1] ?? trimmed;
  if (!json.startsWith("{") && !json.startsWith("[")) return null;
  try {
    const data: unknown = JSON.parse(json);
    if (!data || typeof data !== "object") return null;
    if (Array.isArray(data)) {
      if (data.some(isStructuredDiagnostic)) return null;
      return { code: json, count: `${data.length} items` };
    }
    if (isStructuredDiagnostic(data)) return null;
    const count = "candidates" in data && Array.isArray(data.candidates)
      ? `${data.candidates.length} candidates`
      : `${Object.keys(data).length} fields`;
    return {
      code: json,
      count,
      ...("summary" in data && typeof data.summary === "string" ? { summary: data.summary } : {}),
    };
  } catch {
    return null;
  }
}

function StructuredTextCard({ result }: { result: StructuredText }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="space-y-2">
      {result.summary && <p className="line-clamp-3 text-sm text-ink">{result.summary}</p>}
      <details className="group/result rounded-md border border-line bg-paper"
        onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-xs text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
          <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 transition-transform group-open/result:rotate-90" />
          <Braces aria-hidden className="h-3.5 w-3.5 shrink-0" />
          <span className="font-medium">Structured result</span>
          <span className="ml-auto">{result.count}</span>
        </summary>
        {expanded && <div className="max-h-96 overflow-auto border-t border-line p-2">
          <CodeBlock code={result.code} language="json" />
        </div>}
      </details>
    </div>
  );
}

/**
 * The transcript card for a skill-invocation user message. Synthesizes a
 * settled `tool_call` part and renders it through the SAME ToolCallBlock
 * as the model's own `skill` tool call, so the two paths cannot drift.
 * Trailing user arguments are the caller's to render — they are the
 * user's actual prompt, not part of the skill.
 */
export const SkillInvocationBlock = memo(function SkillInvocationBlock({
  block,
}: {
  block: SkillBlock;
}) {
  const part = useMemo<Extract<MessagePart, { kind: "tool_call" }>>(
    () => ({
      kind: "tool_call",
      callId: "skill-invocation",
      toolName: "skill",
      status: "completed",
      args: { name: block.name },
      result: { text: block.content },
    }),
    [block],
  );
  return <ToolCallBlock part={part} />;
});

/**
 * Read-only strip for a user message's attachments (images and files).
 * Images render as thumbnails; files as compact badges with icons.
 * Sent messages are immutable — no remove control.
 */
function UserAttachmentStrip({
  attachments,
}: {
  attachments: Array<PromptImageAttachment | PromptFileAttachment>;
}) {
  const images = attachments.filter((a): a is PromptImageAttachment => a.kind === "image");
  const files = attachments.filter((a): a is PromptFileAttachment => a.kind === "file");

  return (
    <div className="mb-1.5 space-y-2">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Attached images">
          {images.map((a, i) => (
            <img
              key={`img-${i}`}
              src={a.url}
              alt={a.name}
              className="max-h-40 rounded-lg border border-[--border]"
            />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Attached files">
          {files.map((f, i) => (
            <div
              key={`file-${i}`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-[--border] bg-[--bg-secondary]"
              title={f.path}
            >
              <FileText className="h-4 w-4 text-muted" />
              <span className="truncate">{f.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Terminal-outcome badge for a queued submission, per Task 7 design point 4:
 * superseded/merged read as muted (the turn was cleanly folded away by a
 * later prompt); stopped is neutral, while failed signals an error.
 */
function SettledBadge({ outcome }: { outcome: SettledOutcome }) {
  const isFailure = outcome === "failed";
  const label =
    outcome === "superseded"
      ? "superseded"
      : outcome === "merged"
        ? "merged into next"
        : outcome === "aborted" ? "stopped" : outcome;
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px] font-medium",
        isFailure
          ? "bg-danger-500/10 text-danger-600 dark:text-danger-400"
          : "bg-neutral-200/70 text-muted dark:bg-neutral-800/70",
      )}
    >
      {label}
    </span>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
