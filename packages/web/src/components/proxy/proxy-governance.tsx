/**
 * Shared proxy governance controls: the gateway enable Switch and credential-
 * mode toggle. Used by both the personal `/settings/access` page and the org
 * `/settings/organization/proxy` page. Renders as a set of `FieldRow` entries
 * to be placed inside a `Section` component.
 *
 * `editable={false}` shows the same controls disabled, with a managed note.
 * Single-user mode and an org admin get `editable={true}`.
 */
import { useProxySettings, useSetProxyEnabled, useSetProxyMode } from "~/api/proxy-usage";
import { useOrg } from "~/api/settings";
import { FilterChips, ManagedNote, Switch } from "~/components/primitives";
import { FieldRow } from "~/components/settings/field-row";

const MODES = [
  {
    id: "centralized" as const,
    label: "Centralized",
    desc: "Valet's configured key bills; users only need a valet key.",
  },
  {
    id: "passthrough" as const,
    label: "Pass-through",
    desc: "Each user forwards their own provider key; valet only records.",
  },
];

export interface ProxyGovernanceProps {
  editable: boolean;
}

export function ProxyGovernance({ editable }: ProxyGovernanceProps) {
  const settingsQ = useProxySettings();
  const setEnabled = useSetProxyEnabled();
  const setMode = useSetProxyMode();
  // An org admin changes the gateway on the organization Proxy tab.
  const orgAdmin = useOrg({ enabled: !editable }).data?.callerRole === "admin";

  const enabled = settingsQ.data?.enabled ?? false;
  const mode = settingsQ.data?.mode ?? "centralized";
  const currentMode = MODES.find((m) => m.id === mode);

  return (
    <>
      {/* Gateway on/off */}
      <FieldRow
        label="Gateway"
        hint={
          enabled
            ? "Requests to /proxy are forwarded and recorded."
            : "/proxy requests are rejected until enabled."
        }
        error={setEnabled.isError ? setEnabled.error?.message : undefined}
      >
        <Switch
          checked={enabled}
          onCheckedChange={(v) => setEnabled.mutate(v)}
          disabled={!editable || setEnabled.isPending}
          aria-label={enabled ? "Gateway enabled" : "Gateway disabled"}
        />
        {!editable && <ManagedNote scope="org" askAdmin changeAt={orgAdmin ? "/settings/organization/proxy" : undefined} className="mt-1.5" />}
      </FieldRow>

      {/* Credential mode */}
      <FieldRow
        label="Credential mode"
        hint={currentMode?.desc}
        error={setMode.isError ? setMode.error?.message : undefined}
      >
        <div title={editable && !enabled ? "Enable the gateway first" : undefined}>
          <FilterChips
            label="Credential mode"
            value={mode}
            onChange={(next) => setMode.mutate(next)}
            options={MODES.map((m) => ({ value: m.id, label: m.label, disabled: !editable || setMode.isPending || !enabled }))}
          />
        </div>
      </FieldRow>
    </>
  );
}
