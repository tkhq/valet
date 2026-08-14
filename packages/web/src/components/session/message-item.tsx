import { Bot, User as UserIcon } from "lucide-react";
import type { MessagePart } from "@valet/api/wire";
import type { SettledOutcome, StreamMessage } from "~/stores/stream";
import { Avatar, AvatarFallback } from "~/components/primitives/avatar";
import { Markdown } from "~/components/markdown";
import { pickRenderer, ToolShell } from "./tool-renderers";
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
          </div>
          <div className="space-y-2">
            {message.parts.length === 0 && message.content && (
              <TextBlock text={message.content} />
            )}
            {message.parts.map((part, i) => (
              <PartView key={i} part={part} />
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

function PartView({ part }: { part: MessagePart }) {
  if (part.kind === "text") return <TextBlock text={part.text} />;
  return <ToolCallBlock part={part} />;
}

function TextBlock({ text }: { text: string }) {
  if (!text) return null;
  return <Markdown>{text}</Markdown>;
}

function ToolCallBlock({ part }: { part: Extract<MessagePart, { kind: "tool_call" }> }) {
  const renderer = pickRenderer(part.toolName, part.args);
  const target = renderer.formatTarget(part.args);
  const summary = renderer.formatSummary?.(part.args, part.result, part.status);
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
      <Body
        args={part.args}
        result={part.result}
        status={part.status}
        error={part.error}
      />
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
