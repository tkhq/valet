/**
 * Shared proxy governance controls: the gateway enable Switch and credential-
 * mode toggle. Used by both the personal `/settings/proxy` page and the org
 * `/settings/organization/proxy` page. Renders as a set of `FieldRow` entries
 * to be placed inside a `Section` component.
 *
 * `editable={true}`  — interactive Switch + mode buttons (org admin / single-user)
 * `editable={false}` — read-only status line + "Managed by your organization admins."
 */
import { useProxySettings, useSetProxyEnabled, useSetProxyMode } from "~/api/proxy-usage";
import { Switch } from "~/components/primitives";
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

  const enabled = settingsQ.data?.enabled ?? false;
  const mode = settingsQ.data?.mode ?? "centralized";
  const currentMode = MODES.find((m) => m.id === mode);

  if (!editable) {
    const gatewayLabel = enabled ? "On" : "Off";
    const modeLabel = mode === "centralized" ? "Centralized mode" : "Pass-through mode";
    return (
      <FieldRow label="Gateway">
        <div className="space-y-1">
          <p className="text-sm text-ink">
            {`Gateway: ${gatewayLabel} · ${modeLabel}`}
          </p>
          <p className="text-xs text-muted">Managed by your organization admins.</p>
        </div>
      </FieldRow>
    );
  }

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
          disabled={setEnabled.isPending}
          aria-label={enabled ? "Gateway enabled" : "Gateway disabled"}
        />
      </FieldRow>

      {/* Credential mode */}
      <FieldRow
        label="Credential mode"
        hint={currentMode?.desc}
        error={setMode.isError ? setMode.error?.message : undefined}
      >
        <div
          className="flex items-center gap-1"
          role="group"
          aria-label="Credential mode"
        >
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode.mutate(m.id)}
              disabled={setMode.isPending || !enabled}
              title={!enabled ? "Enable the gateway first" : undefined}
              className={`rounded px-3 py-1 text-sm border transition-colors ${
                mode === m.id
                  ? "border-moss text-moss bg-moss/10 font-medium"
                  : "border-line text-muted hover:text-ink hover:border-ink disabled:opacity-40 disabled:cursor-not-allowed"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </FieldRow>
    </>
  );
}
