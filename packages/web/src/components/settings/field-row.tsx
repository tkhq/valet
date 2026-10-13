import type { ReactNode } from "react";

/**
 * One labeled control within a `Section`'s hairline stack: label (+ optional
 * hint) on the left, the control on the right. Stacks to a single column
 * below `sm` so long labels/controls don't collide on narrow viewports. The
 * label column keeps 8rem in a narrow pane, and an error sits under the
 * control, where it has the control's width.
 */
export function FieldRow({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 py-3.5 first:pt-0.5 last:pb-0.5 sm:grid-cols-[minmax(8rem,1fr)_minmax(0,24rem)] sm:items-start sm:gap-6">
      <div className="min-w-0 sm:pt-2">
        <div className="text-sm text-ink">{label}</div>
        {hint && <p className="mt-0.5 max-w-xs text-xs leading-5 text-muted">{hint}</p>}
      </div>
      <div className="min-w-0">
        {children}
        {error && <p role="alert" className="mt-1.5 text-xs text-danger-500">{error}</p>}
      </div>
    </div>
  );
}
