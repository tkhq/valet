import type { ReactNode } from "react";
import { cn } from "~/lib/cn";
import { CONTROL_SIZE } from "./control.js";

type Layout = "wrap" | "scroll";

const LAYOUT: Record<Layout, string> = {
  wrap: "flex-wrap",
  // One line that scrolls sideways when it is wider than its box. The
  // padding keeps each chip's focus ring inside the scroll box.
  scroll: "flex-nowrap overflow-x-auto p-0.5",
};

/**
 * A row of single-choice chips, such as a log's status filter or a tool's
 * Allow / Ask first / Off. The selected chip is filled; the others read as
 * quiet outlines. Each chip is a toggle button, so a screen reader hears
 * which one is on. `value` may match no chip, and a chip may be disabled.
 * `layout="scroll"` keeps the chips on one line, as in a narrow dialog.
 */
export function FilterChips<T extends string>({ options, value, onChange, label, layout = "wrap", className }: {
  options: readonly { value: T; label: ReactNode; disabled?: boolean }[];
  value: T | undefined;
  onChange: (value: T) => void;
  label: string;
  layout?: Layout;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn("flex gap-1.5", LAYOUT[layout], className)}>
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
              "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 transition-colors", CONTROL_SIZE.sm,
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
