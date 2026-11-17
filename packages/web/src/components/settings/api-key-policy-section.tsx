import { useState } from "react";
import { API_KEY_LIFETIME_DAYS } from "@valet/shared";
import { ErrorRow, LoadingRow, Select, Switch } from "~/components/primitives";
import { FieldRow } from "~/components/settings/field-row";
import { Section } from "~/components/settings/section";
import { useOrg, usePatchOrgSettings } from "~/api/settings";
import { apiErrorMessage } from "~/api/policies";

const NO_LIMIT = "none";

function lifetimeLabel(days: number): string {
  return days === 365 ? "1 year" : `${days} days`;
}

/**
 * Organization · Policies: the API key policy (`PATCH /api/org/settings`
 * `allowPersonalApiKeys`, `maxApiKeyLifetimeDays`). The api enforces both
 * when a key is created. Existing keys keep their expiry.
 */
export function ApiKeyPolicySection() {
  const orgQ = useOrg();
  const patch = usePatchOrgSettings();
  const [error, setError] = useState<string | null>(null);
  const isAdmin = orgQ.data?.callerRole === "admin";

  function save(body: { allowPersonalApiKeys?: boolean; maxApiKeyLifetimeDays?: number | null }) {
    setError(null);
    patch.mutate(body, { onError: (err) => setError(apiErrorMessage(err)) });
  }

  const maxDays = orgQ.data?.maxApiKeyLifetimeDays ?? null;

  return (
    <Section title="API keys" description="Control who can create personal API keys and how long new keys stay valid.">
      {orgQ.isLoading && <LoadingRow />}
      {orgQ.error && <ErrorRow>Failed to load the API key policy. Reload the page to try again.</ErrorRow>}
      {orgQ.data && (
        <>
          <FieldRow
            label="Allow personal API keys"
            hint="Off: nobody can create personal keys or proxy keys, admins included. Existing keys keep working. Team admins can still create team keys."
          >
            <Switch
              checked={orgQ.data.allowPersonalApiKeys ?? true}
              disabled={!isAdmin || patch.isPending}
              onCheckedChange={(next) => save({ allowPersonalApiKeys: next })}
              aria-label="Allow personal API keys"
            />
          </FieldRow>
          <FieldRow
            label="Maximum key lifetime"
            hint="Applies to new personal and team keys. Existing keys keep their expiry."
          >
            <Select
              aria-label="Maximum key lifetime"
              className="w-auto"
              value={maxDays === null ? NO_LIMIT : String(maxDays)}
              disabled={!isAdmin || patch.isPending}
              onChange={(e) => save({ maxApiKeyLifetimeDays: e.target.value === NO_LIMIT ? null : Number(e.target.value) })}
            >
              <option value={NO_LIMIT}>No limit</option>
              {API_KEY_LIFETIME_DAYS.map((days) => (
                <option key={days} value={String(days)}>{lifetimeLabel(days)}</option>
              ))}
            </Select>
          </FieldRow>
          {!isAdmin && <p className="text-xs text-muted">Only an organization admin can change these settings.</p>}
          {error && <p role="alert" className="text-sm text-danger-500">{error}</p>}
        </>
      )}
    </Section>
  );
}
