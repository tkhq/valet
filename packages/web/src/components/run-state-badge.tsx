import type { SessionRunState } from "@valet/api/wire";
import { Badge } from "~/components/primitives";
import { cn } from "~/lib/cn";

/**
 * One status vocabulary, one chip. Sessions, workflow runs, event
 * deliveries and connection health all want a coloured marker on a row,
 * and each surface was about to describe its own — five names for the same
 * thing, drifting apart on the first change.
 *
 * The words are the user's, not the system's. `needs_you` says who is
 * blocking rather than naming the mechanism ("awaiting decision gate"), and
 * it takes amber because amber is what this palette already uses for
 * waiting (see the presence mark in theme.css). Everything else stays quiet:
 * a list where five rows shout is a list nobody reads.
 */
const PRESENTATION: Record<
  SessionRunState,
  { label: string; variant: "neutral" | "accent" | "success" | "warning" | "danger"; dot?: string }
> = {
  // The only state that is blocked on a person, so the only one that gets
  // a colour with urgency in it.
  needs_you: { label: "Needs you", variant: "warning" },
  // A live pulse reads as progress without a per-row timer. Reduced motion
  // keeps the dot and drops the animation.
  working: { label: "Working", variant: "accent", dot: "animate-pulse motion-reduce:animate-none" },
  failed: { label: "Failed", variant: "danger" },
  sleeping: { label: "Sleeping", variant: "neutral" },
  idle: { label: "Idle", variant: "neutral" },
};

export interface RunStateBadgeProps {
  state: SessionRunState;
  className?: string;
}

export function RunStateBadge({ state, className }: RunStateBadgeProps) {
  const { label, variant, dot } = PRESENTATION[state];

  return (
    <Badge variant={variant} className={cn("gap-1.5", className)}>
      {dot !== undefined && (
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full bg-current", dot)} aria-hidden />
      )}
      {label}
    </Badge>
  );
}

/** The label alone, for places that need the word without the chip — a
 * tooltip, an aria-label, a filter chip. Keeps one spelling of each state. */
export function runStateLabel(state: SessionRunState): string {
  return PRESENTATION[state].label;
}
