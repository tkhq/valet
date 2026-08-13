import type { Message } from "@valet/api/wire";
import { cn } from "~/lib/cn";
import { Markdown } from "~/components/markdown";

/**
 * CommandResult renders a `command_result` wire message as a compact card.
 * The card has a 2px left rail and a header row with the command name chip
 * and source badge. The markdown body follows below the header.
 *
 * ok=true → neutral/muted accent (matches signal-card moss rail style)
 * ok=false → danger/red accent (matches tool-shell error border style)
 *
 * Returns null when `message.command` is absent — callers are responsible
 * for only routing command-bearing messages here, but a null guard is
 * included for safety.
 */
export function CommandResult({ message }: { message: Message }) {
  const command = message.command;
  if (!command) return null;

  const { name, source, ok } = command;

  return (
    <div
      className={cn(
        "mx-4 my-3 flex overflow-hidden rounded-md border bg-paper",
        ok
          ? "border-line border-l-2 border-l-neutral-400"
          : "border-danger-500/40 border-l-2 border-l-danger-500",
      )}
    >
      {/* Left rail — 2px color strip */}
      <div
        aria-hidden
        className={cn(
          "w-[2px] shrink-0",
          ok ? "bg-neutral-400" : "bg-danger-500",
        )}
      />

      <div className="flex-1 min-w-0 px-4 py-3">
        {/* Header row: /name chip + source badge */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-[13px] font-semibold text-ink tracking-tight">
            /{name}
          </span>
          <span
            className={cn(
              "inline-flex items-center rounded-sm px-1.5 py-0.5",
              "text-[11px] font-medium tracking-wide",
              "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
            )}
          >
            {source}
          </span>
        </div>

        {/* Markdown body */}
        {message.content && (
          <div className="mt-2 text-sm text-ink">
            <Markdown>{message.content}</Markdown>
          </div>
        )}
      </div>
    </div>
  );
}
