import { useState } from "react";
import { Button, Popover, PopoverContent, PopoverTrigger } from "~/components/primitives";
import { useSendPrompt } from "~/api/queries";
import { useThreadContext } from "~/api/thread-context";
import { cn } from "~/lib/cn";
import { errorText } from "~/lib/error-text";
import { formatTokens } from "~/lib/format-usage";
import { shortModelLabel } from "~/lib/models";

/** From this fill the meter turns amber: the next long turn can reach the limit. */
const HIGH_FILL = 0.8;

/**
 * How full the thread's model context is, beside the composer's send button.
 * The ring fills toward the budget at which the assistant compacts the thread
 * by itself (`Thread.contextUsage`). Its popover explains the number and runs
 * `/compact`, the same command the person can type with instructions.
 */
export function ContextMeter({ sessionId, threadId, working }: {
  sessionId: string;
  threadId: string;
  /** A turn holds the thread. Compaction waits for it to end. */
  working: boolean;
}) {
  const { data } = useThreadContext(sessionId, threadId);
  const send = useSendPrompt(sessionId);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const context = data?.context;
  if (!context) return null;

  const fill = Math.min(1, context.tokens / context.limit);
  const percent = Math.round(fill * 100);
  const high = fill >= HIGH_FILL;

  async function compact() {
    setError(null);
    try {
      await send.mutateAsync({ text: "/compact", threadId });
      setOpen(false);
    } catch (err) {
      setError(errorText(err, "The compaction did not start. Try again."));
    }
  }

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setError(null); }}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Context ${percent}% full`}
          title={`Context ${percent}% full`}
          className={cn("shrink-0 rounded-full tabular-nums", high ? "text-amber-500" : "text-muted")}
        >
          <ContextRing fill={fill} />
          <span className="max-sm:sr-only">{percent}%</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" className="w-72 space-y-2 text-sm">
        <p className="font-medium text-ink">Context {percent}% full</p>
        <p className="text-xs text-muted">
          {formatTokens(context.tokens)} of {formatTokens(context.limit)} tokens on {shortModelLabel(context.model)}.
        </p>
        <p className="text-xs text-muted">
          {context.autoCompact
            ? "When it is full, the assistant compacts the thread: it summarizes older turns and keeps the recent ones."
            : "Automatic compaction is off for this session. Compact the thread before the context is full."}
        </p>
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-xs text-muted">Or send /compact with instructions.</span>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={working || send.isPending}
            title={working ? "Wait for the current turn to finish." : undefined}
            onClick={() => void compact()}
          >
            {send.isPending ? "Compacting…" : "Compact now"}
          </Button>
        </div>
        {error && <p role="alert" className="text-xs text-danger-600 dark:text-danger-500">{error}</p>}
      </PopoverContent>
    </Popover>
  );
}

/** A 16px ring whose arc is the filled share of the budget. */
function ContextRing({ fill }: { fill: number }) {
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 -rotate-90" aria-hidden>
      <circle cx="8" cy="8" r={radius} fill="none" strokeWidth="2" className="stroke-line" />
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        strokeWidth="2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeDasharray={`${fill * circumference} ${circumference}`}
      />
    </svg>
  );
}
