/**
 * Thumbs up/down pair (TKAI-334). Minimal by design: two icon buttons, no
 * modal, no comment field — the rating itself is the signal. Clicking the
 * active thumb clears the rating.
 */
import { ThumbsDown, ThumbsUp } from "lucide-react";
import type { RatingValue } from "@valet/api/wire";
import { Tooltip } from "~/components/primitives";
import { cn } from "~/lib/cn";

export function RatingButtons({
  value,
  onRate,
  disabled,
  subject,
  className,
}: {
  value: RatingValue | null;
  onRate: (rating: RatingValue | null) => void;
  disabled?: boolean;
  /** What is being rated, for labels: "session" or "reply". */
  subject: string;
  className?: string;
}) {
  const button = (rating: RatingValue) => {
    const active = value === rating;
    const Icon = rating === "positive" ? ThumbsUp : ThumbsDown;
    const label = `${rating === "positive" ? "Good" : "Bad"} ${subject}`;
    return (
      <Tooltip content={active ? `${label} — click to clear` : label}>
        <button
          type="button"
          aria-label={label}
          aria-pressed={active}
          disabled={disabled}
          onClick={() => onRate(active ? null : rating)}
          className={cn(
            "rounded p-1 text-muted/70 hover:text-[--fg] hover:bg-ink-wash transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40",
            "disabled:opacity-50",
            active &&
              (rating === "positive"
                ? "text-success-600 dark:text-success-500"
                : "text-danger-500"),
          )}
        >
          <Icon className={cn("h-3.5 w-3.5", active && "fill-current")} />
        </button>
      </Tooltip>
    );
  };

  return (
    <div className={cn("flex items-center gap-0.5", className)} data-rated={value ?? undefined}>
      {button("positive")}
      {button("negative")}
    </div>
  );
}
