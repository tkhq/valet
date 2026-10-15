import type { ReactNode } from "react";
import { cn } from "~/lib/cn";

/**
 * A row of single-choice chips, such as a log's status filter or a tool's
 * Allow / Ask first / Off. The selected chip is filled; the others read as
 * quiet outlines. Each chip is a toggle button, so a screen reader hears
 * which one is on. `value` may match no chip, and a chip may be disabled.
 */
export function FilterChips<T extends string>({ options, value, onChange, label, className }: {
  options: readonly { value: T; label: ReactNode; disabled?: boolean }[];
  value: T | undefined;
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn("flex flex-wrap gap-1.5", className)}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors max-sm:min-h-11",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss",
              "disabled:cursor-not-allowed disabled:opacity-50",
              selected ? "border-ink bg-ink text-paper" : "border-line text-muted hover:border-muted hover:text-ink",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
