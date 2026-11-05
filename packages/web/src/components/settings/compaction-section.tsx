import { useState } from "react";
import { Label, Select, Spinner } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { useOrg, usePatchOrgSettings } from "~/api/settings";
import { apiErrorMessage } from "~/api/policies";

/** Window choices. "" stores null (the Valet default); "0" turns the cap off. */
const WINDOW_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "Valet default (200k tokens)" },
  { value: "100000", label: "100k tokens" },
  { value: "150000", label: "150k tokens" },
  { value: "300000", label: "300k tokens" },
  { value: "500000", label: "500k tokens" },
  { value: "0", label: "Model limit (no cap)" },
];

/**
 * Organization · Models — the compaction window (`PATCH /api/org/settings`
 * `compactionWindowTokens`). A thread above the window compacts when it goes
 * idle, or at the end of an unattended or channel turn. A stored value that
 * is not a preset still shows as its own option.
 */
export function CompactionSection() {
  const orgQ = useOrg();
  const patchSettings = usePatchOrgSettings();
  const [error, setError] = useState<string | null>(null);

  const stored = orgQ.data?.compactionWindowTokens;
  const value = stored === null || stored === undefined ? "" : String(stored);
  const options = WINDOW_OPTIONS.some((o) => o.value === value)
    ? WINDOW_OPTIONS
    : [...WINDOW_OPTIONS, { value, label: `${Math.round(Number(value) / 1000)}k tokens` }];
  const isAdmin = orgQ.data?.callerRole === "admin";

  function setWindow(next: string) {
    setError(null);
    patchSettings.mutate(
      { compactionWindowTokens: next === "" ? null : Number(next) },
      { onError: (err) => setError(apiErrorMessage(err)) },
    );
  }

  return (
    <Section
      title="Context"
      description="Set how large a thread's context can grow before Valet summarizes older turns. A smaller window costs less per reply."
    >
      {orgQ.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {orgQ.error && <p className="py-4 text-sm text-danger-500">Failed to load context settings.</p>}

      {orgQ.data && (
        <div className="space-y-2 py-4">
          <div className="max-w-xs">
            <Label htmlFor="compaction-window">Compaction window</Label>
            <Select
              id="compaction-window"
              value={value}
              disabled={!isAdmin || patchSettings.isPending}
              onChange={(e) => setWindow(e.target.value)}
              className="mt-1 w-full"
            >
              {options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
          </div>
          <p className="text-xs text-muted">
            A thread over the window is summarized when it goes idle, shortly before its prompt cache expires, or right
            after a Slack or unattended turn.{isAdmin ? "" : " Only an org admin can change this."}
          </p>
          {error && <p className="text-xs text-danger-500">{error}</p>}
        </div>
      )}
    </Section>
  );
}
