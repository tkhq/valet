import type { ReactNode } from "react";
import { cn } from "~/lib/cn";

/**
 * A single radio option rendered as a quiet card: title + one-line
 * description, moss ring when selected (split-settings design, "Visual
 * direction" — used for Appearance's System/Light/Dark choice). Callers
 * compose a `role="radiogroup"` wrapper around a row of these; each card
 * is itself `role="radio"`.
 */
export function RadioCard({
  title,
  description,
  selected,
  onSelect,
  icon,
  className,
}: {
  title: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex flex-1 flex-col items-start gap-2 rounded border bg-[--bg] px-4 py-3 text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss/40",
        selected
          ? "border-moss ring-1 ring-moss"
          : "border-line hover:border-moss/50",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        {icon && (
          <span className={cn("text-muted", selected && "text-moss")} aria-hidden>
            {icon}
          </span>
        )}
        <span className={cn("text-sm font-medium", selected ? "text-moss" : "text-ink")}>
          {title}
        </span>
      </div>
      <span className="text-xs text-muted">{description}</span>
    </button>
  );
}
