import { useState } from "react";
import { Label, Select, Spinner } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { useOrgReasoning, usePatchOrgReasoning } from "~/api/settings";
import { apiErrorMessage } from "~/api/policies";
import { VALET_DEFAULT_REASONING } from "@valet/api/wire";
import { levelsUpTo, REASONING_LABELS, REASONING_LEVELS, reasoningLabelFor } from "~/lib/reasoning";

/**
 * Organization · Models — default and max reasoning levels
 * (model-selector-overhaul, Task 13). `GET`/`PATCH /api/org/reasoning`
 * stores each field as an explicit level or unset (Valet default / no cap).
 * A default above the chosen max is disabled in the picker rather than
 * silently clamped, per `levelsUpTo`. The unset option names the level new
 * threads get: `VALET_DEFAULT_REASONING`, clamped to the max like the api.
 */
export function ReasoningSection() {
  const reasoningQ = useOrgReasoning();
  const patchReasoning = usePatchOrgReasoning();
  const [error, setError] = useState<string | null>(null);

  const data = reasoningQ.data;
  const defaultLevel = data?.default ?? "";
  const maxLevel = data?.max ?? "";
  const allowedDefaults = new Set(levelsUpTo(maxLevel || undefined));
  const builtInDefault = allowedDefaults.has(VALET_DEFAULT_REASONING) ? VALET_DEFAULT_REASONING : maxLevel;

  function setDefault(value: string) {
    setError(null);
    patchReasoning.mutate(
      { default: value || null },
      { onError: (err) => setError(apiErrorMessage(err)) },
    );
  }

  function setMax(value: string) {
    setError(null);
    patchReasoning.mutate(
      { max: value || null },
      { onError: (err) => setError(apiErrorMessage(err)) },
    );
  }

  return (
    <Section
      title="Reasoning"
      description="Set the default and maximum extended-thinking levels for runtimes in this organization."
    >
      {reasoningQ.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {reasoningQ.error && (
        <p className="py-4 text-sm text-danger-500">Failed to load reasoning settings.</p>
      )}

      {data && (
        <div className="space-y-4 py-4">
          <div className="grid max-w-md grid-cols-2 gap-4">
            <div>
              <Label htmlFor="reasoning-default">Default</Label>
              <Select
                id="reasoning-default"
                value={defaultLevel}
                onChange={(e) => setDefault(e.target.value)}
                className="mt-1 w-full"
              >
                <option value="">Valet default ({reasoningLabelFor(builtInDefault)})</option>
                {REASONING_LEVELS.map((level) => (
                  <option key={level} value={level} disabled={!allowedDefaults.has(level)}>
                    {REASONING_LABELS[level]}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="reasoning-max">Max</Label>
              <Select
                id="reasoning-max"
                value={maxLevel}
                onChange={(e) => setMax(e.target.value)}
                className="mt-1 w-full"
              >
                <option value="">No cap</option>
                {REASONING_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {REASONING_LABELS[level]}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {error && <p className="text-xs text-danger-500">{error}</p>}
        </div>
      )}
    </Section>
  );
}
