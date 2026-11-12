import type { ReactNode } from "react";
import { cn } from "~/lib/cn";
import { FOCUS_RING } from "./control.js";

/**
 * A single radio option rendered as a quiet card: title + one-line
 * description, a moss border and wash when selected. Use it for every
 * selectable card, such as a theme, a member role, or a review method.
 * Callers compose a `role="radiogroup"` wrapper around a row of these; each
 * card is itself `role="radio"`. `children` shows below the description,
 * such as the passes of a review method.
 */
export function RadioCard({
  title,
  description,
  selected,
  onSelect,
  icon,
  className,
  ariaLabel,
  disabled,
  children,
}: {
  title: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
  icon?: ReactNode;
  className?: string;
  /** Overrides the accessible name. Without it the name is the card's whole
   * text (title + description). */
  ariaLabel?: string;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex flex-1 flex-col items-start gap-2 rounded border bg-[--bg] px-4 py-3 text-left transition-colors",
        FOCUS_RING,
        "disabled:cursor-not-allowed disabled:opacity-60",
        // Selected is a moss border on a moss wash, with no ring, so the
        // focus ring stays the only ring on the card. `moss-text` and
        // `muted` hold 4.5:1 on the wash (`theme.tokens.test.ts`).
        selected
          ? "border-moss bg-moss-wash"
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
        <span className={cn("text-sm font-medium", selected ? "text-moss-text" : "text-ink")}>
          {title}
        </span>
      </div>
      <span className="text-xs text-muted">{description}</span>
      {children}
    </button>
  );
}
