import { useOrgReasoning } from "~/api/settings";
import { levelsUpTo, REASONING_LABELS } from "~/lib/reasoning";

const SELECT_CLASS = "h-9 w-full rounded border border-[--border] bg-[--bg] px-2 text-sm text-[--fg]";

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
}: {
  value: string | null;
  onChange: (level: string | null) => void;
  emptyLabel?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const orgReasoningQ = useOrgReasoning();
  const levels = levelsUpTo(orgReasoningQ.data?.max);

  return (
    <select
      aria-label={ariaLabel}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      className={SELECT_CLASS}
      disabled={disabled}
    >
      <option value="">{emptyLabel}</option>
      {levels.map((level) => (
        <option key={level} value={level}>
          {REASONING_LABELS[level]}
        </option>
      ))}
    </select>
  );
}
