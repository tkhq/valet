import { Bot, User as UserIcon, FileText } from "lucide-react";
import type { MessagePart, PromptImageAttachment, PromptFileAttachment } from "@valet/api/wire";
import type { SettledOutcome, StreamMessage } from "~/stores/stream";
import { Avatar, AvatarFallback } from "~/components/primitives/avatar";
import { Markdown } from "~/components/markdown";
import { CopyButton } from "./tool-renderers/tool-shell";
import { pickRenderer, ToolShell } from "./tool-renderers";
import { showsLiveBody } from "./tool-renderers/types";
import { ToolBody } from "./tool-renderers/tool-shell";
import { Thinking } from "./tool-renderers/thinking";
import { parseSkillBlock, SkillInvocationBlock } from "./tool-renderers/skill";
import { cn } from "~/lib/cn";

export function MessageItem({
  message,
  suppressEmptyPlaceholder = false,
}: {
  message: StreamMessage;
  /** True for the last message while the agent is mid-turn — an empty
   *  assistant row is then a streaming placeholder, not a failed turn. */
  suppressEmptyPlaceholder?: boolean;
}) {
  const isUser = message.role === "user";
  const copyText = messageCopyText(message);
  return (
    <article className={cn("group px-4 py-3", isUser && "bg-neutral-100/50 dark:bg-neutral-900/40")}>
      {/* Row background spans full width; the content column is capped at a
          readable measure and centered — prose and tool cards both benefit. */}
      <div className="mx-auto flex w-full max-w-4xl gap-3">
        <Avatar size="sm">
          <AvatarFallback>
            {isUser ? <UserIcon className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0 space-y-2">
          <div className="text-xs text-muted flex items-center gap-2">
            <span className="font-medium text-[--fg]/80">
              {isUser ? "You" : message.role === "assistant" ? "Assistant" : message.role}
            </span>
            <span>•</span>
            <span>{formatTime(message.createdAt)}</span>
            {message.role === "assistant" && message.model && (
              <span
                className="font-mono text-[10px] text-muted opacity-80"
                title={message.model}
              >
                {shortModelLabel(message.model)}
              </span>
            )}
            {message.settledOutcome && <SettledBadge outcome={message.settledOutcome} />}
            {copyText && (
              <CopyButton
                getText={() => copyText}
                label="Copy message"
                className="ml-auto opacity-0 group-hover:opacity-100"
              />
            )}
          </div>
          <div className="space-y-2">
            {isUser && message.attachments && message.attachments.length > 0 && (
              <UserAttachmentStrip attachments={message.attachments} />
            )}
            {message.parts.length === 0 && message.content && (
              <TextBlock text={message.content} />
            )}
            {message.parts.map((part, i) => (
              // Tool cards hold per-mount UI state (expansion, user-touch
              // override), so key them by their stable callId: an index key
              // hands one call's state to a different call whenever the
              // parts array shifts (streaming sweep, message_update
              // replacement). Text/thinking parts are stateless and
              // positional, so the index is fine for them.
              <PartView
                key={part.kind === "tool_call" ? `tc-${part.callId}` : `${part.kind}-${i}`}
                part={part}
              />
            ))}
            {!suppressEmptyPlaceholder && isEmptyAssistantMessage(message) && (
              <p className="text-xs italic text-muted">
                (no response — the turn failed or was interrupted before any
                output; see the error above or the server logs)
              </p>
            )}
          </div>
        </div>
      </div>
    </article>
  );
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
 * The clipboard payload for a message's copy button: the visible prose —
 * text parts joined by blank lines, or the legacy `content` field when a
 * message has no parts. Thinking and tool-call parts stay out; the debug
 * transcript (session header) covers those. Empty string means no button.
 * Exported for tests.
 */
export function messageCopyText(message: StreamMessage): string {
  const texts = message.parts
    .filter((p): p is Extract<MessagePart, { kind: "text" }> => p.kind === "text")
    .map((p) => p.text.trim())
    .filter(Boolean);
  if (texts.length > 0) return texts.join("\n\n");
  return message.content?.trim() ?? "";
}

function PartView({ part }: { part: MessagePart }) {
  switch (part.kind) {
    case "text":
      return <TextBlock text={part.text} />;
    case "thinking":
      return <Thinking text={part.text} />;
    case "tool_call":
      return <ToolCallBlock part={part} />;
  }
}

function TextBlock({ text }: { text: string }) {
  if (!text) return null;
  // A slash-command skill invocation arrives as the dispatcher's
  // `<skill name="...">…</skill>` expansion. Render it as the same card
  // the `skill` tool call gets, with the user's trailing arguments (their
  // actual prompt) as normal prose below it.
  const skill = parseSkillBlock(text);
  if (skill) {
    return (
      <>
        <SkillInvocationBlock block={skill} />
        {skill.rest && <Markdown>{skill.rest}</Markdown>}
      </>
    );
  }
  return <Markdown>{text}</Markdown>;
}

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

function ToolCallBlock({ part }: { part: Extract<MessagePart, { kind: "tool_call" }> }) {
  const renderer = pickRenderer(part.toolName, part.args);
  // A held renderer (streaming, no streamsArgs opt-in) gets a bare header:
  // formatTarget/formatSummary would compute from partial, jagged args
  // (truncated paths, churning line counts) the renderer never opted to see.
  const live = showsLiveBody(renderer, part.status);
  const target = live ? renderer.formatTarget(part.args, part.toolName) : undefined;
  const summary = live
    ? renderer.formatSummary?.(part.args, part.result, part.status, part.toolName)
    : undefined;
  const Body = renderer.Body;

  return (
    <ToolShell
      toolName={part.toolName}
      category={renderer.category}
      Icon={renderer.Icon}
      target={target}
      summary={summary}
      status={part.status}
    >
      {live ? (
        <Body
          args={part.args}
          result={part.result}
          status={part.status}
          error={part.error}
          toolName={part.toolName}
        />
      ) : (
        // Args are still streaming and this renderer didn't opt in — hold
        // the body until the call is complete, like before streaming existed.
        <ToolBody className="text-[11px] text-muted italic font-mono">
          receiving arguments…
        </ToolBody>
      )}
    </ToolShell>
  );
}

/**
 * Terminal-outcome badge for a queued submission, per Task 7 design point 4:
 * superseded/merged read as muted (the turn was cleanly folded away by a
 * later prompt); failed/aborted read as a subtle failure signal.
 */
function SettledBadge({ outcome }: { outcome: SettledOutcome }) {
  const isFailure = outcome === "failed" || outcome === "aborted";
  const label =
    outcome === "superseded"
      ? "superseded"
      : outcome === "merged"
        ? "merged into next"
        : outcome;
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
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Compact model label for the message header: strips a provider prefix
 * ("anthropic/claude-haiku-4-5" → "claude-haiku-4-5"). Full id stays in the
 * title tooltip.
 */
function shortModelLabel(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(slash + 1) : model;
}
