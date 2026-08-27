import { Link, createFileRoute } from "@tanstack/react-router";
import { useProxySettings, useSetProxyEnabled, useSetProxyMode } from "~/api/proxy-usage";
import { useOrg } from "~/api/settings";
import { Switch } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { FieldRow } from "~/components/settings/field-row";

/**
 * `/settings/organization/proxy` — Organization · Proxy: enable/disable the
 * LLM recording gateway and choose the credential mode. Renders inside
 * `/settings/organization`'s OrgRouteGuard — no per-page admin re-check.
 */
export const Route = createFileRoute("/settings/organization/proxy")({
  component: OrganizationProxyPage,
});

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

export function OrganizationProxyPage() {
  const orgQ = useOrg();
  const settingsQ = useProxySettings();
  const setEnabled = useSetProxyEnabled();
  const setMode = useSetProxyMode();

  const isAdmin = orgQ.data?.callerRole === "admin";
  const enabled = settingsQ.data?.enabled ?? false;
  const mode = settingsQ.data?.mode ?? "centralized";
  const currentMode = MODES.find((m) => m.id === mode);

  return (
    <div className="space-y-10">
      <Section
        title="Proxy"
        description="Records external Claude Code and Codex traffic for spend tracking and observability."
      >
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
          {isAdmin ? (
            <Switch
              checked={enabled}
              onCheckedChange={(v) => setEnabled.mutate(v)}
              disabled={setEnabled.isPending}
              aria-label={enabled ? "Gateway enabled" : "Gateway disabled"}
            />
          ) : (
            <span className="text-sm text-muted">
              {enabled ? "Enabled" : "Disabled"}
            </span>
          )}
        </FieldRow>

        {/* Credential mode */}
        <FieldRow
          label="Credential mode"
          hint={currentMode?.desc}
          error={setMode.isError ? setMode.error?.message : undefined}
        >
          {isAdmin ? (
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
          ) : (
            <span className="rounded border border-line px-3 py-1 text-sm text-muted">
              {currentMode?.label ?? mode}
            </span>
          )}
        </FieldRow>
      </Section>

      {/* Link to usage dashboard */}
      <p className="text-sm text-muted">
        <Link to="/usage" className="text-moss underline-offset-2 hover:underline">
          View recorded usage →
        </Link>
      </p>
    </div>
  );
}
