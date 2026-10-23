import { ChevronDown } from "lucide-react";
import { useOrgReasoning } from "~/api/settings";
import { Select } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { levelsUpTo, REASONING_LABELS, reasoningLabelFor } from "~/lib/reasoning";

/**
 * Small labeled `<select>` for a reasoning/thinking-level override: an
 * empty option (default label "Inherit", configurable per surface — the
 * fallback differs: assistant falls to the account default, personal falls
 * to team/org, team falls to the org default) plus every level up to the
 * org's configured max (`GET /api/org/reasoning`, Task 13). Shared by the
 * per-assistant editor, the personal default, and the team-defaults editor
 * so the three surfaces offer the exact same vocabulary and cap.
 *
 * `onChange` receives `null` for the empty option — never `""` — so callers
 * can pass the result straight through to a PATCH body that clears the
 * field back to inherit.
 */
export function ReasoningSelect({
  value,
  onChange,
  emptyLabel = "Inherit",
  ariaLabel = "Reasoning",
  disabled = false,
  allowedLevels,
  id,
  descriptionId,
  chevron = "native",
  surface = "field",
}: {
  value: string | null;
  onChange: (level: string | null) => void;
  emptyLabel?: string;
  ariaLabel?: string;
  disabled?: boolean;
  /** Model-specific support, intersected with the organization limit. */
  allowedLevels?: readonly string[];
  id?: string;
  descriptionId?: string;
  chevron?: "native" | "inset";
  surface?: "field" | "plain";
}) {
  const orgReasoningQ = useOrgReasoning();
  const levels = levelsUpTo(orgReasoningQ.data?.max).filter(level => allowedLevels === undefined || allowedLevels.includes(level));
  const unavailableValue = value && !levels.some(level => level === value) ? value : null;

  const select = (
    <Select
      id={id}
      aria-label={ariaLabel}
      aria-describedby={descriptionId}
      value={value ?? ""}
      onChange={(e) => {
        const next = e.target.value;
        if (next === "" || levels.some(level => level === next)) onChange(next === "" ? null : next);
      }}
      className={cn("w-full", chevron === "inset" && "appearance-none pr-10", surface === "plain" && "border-transparent bg-transparent text-right")}
      disabled={disabled || (levels.length === 0 && unavailableValue === null)}
    >
      <option value="">{emptyLabel}</option>
      {unavailableValue && <option value={unavailableValue} disabled>{reasoningLabelFor(unavailableValue)} (unavailable)</option>}
      {levels.map((level) => (
        <option key={level} value={level}>
          {REASONING_LABELS[level]}
        </option>
      ))}
    </Select>
  );
  return chevron === "inset" ? (
    <div className="relative">
      {select}
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
    </div>
  ) : select;
}
