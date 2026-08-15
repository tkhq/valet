import { useState } from "react";
import { Trash2 } from "lucide-react";
import type { ApprovalModeWire, RiskLevelWire } from "@valet/api/wire";
import { Badge, Button, Label } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import {
  apiErrorMessage,
  useDeleteMyPolicyOverride,
  useMyPolicyOverrides,
  usePutMyPolicyOverride,
} from "~/api/policies";
import { ServiceActionCombobox } from "./service-action-combobox";

const MODES: readonly ApprovalModeWire[] = ["allow", "require_approval", "deny"];
const RISK_LEVELS: readonly RiskLevelWire[] = ["low", "medium", "high", "critical"];

const MODE_BADGE: Record<ApprovalModeWire, "success" | "accent" | "danger"> = {
  allow: "success",
  require_approval: "accent",
  deny: "danger",
};

type TargetKind = "service" | "actionId" | "riskLevel";

function targetLabel(o: { service: string | null; actionId: string | null; riskLevel: RiskLevelWire | null }) {
  if (o.actionId) return `action: ${o.actionId}`;
  if (o.riskLevel) return `risk: ${o.riskLevel}`;
  if (o.service) return `service: ${o.service}`;
  return "(no target)";
}

/**
 * `/settings/policies` — "My policy overrides" (action-policies plan,
 * Task 5). Per-user overrides layer on top of org policy; a write that
 * would loosen past an org `deny`/`require_approval` 400s with an
 * instructive message, surfaced verbatim below the form (not swallowed into
 * a toast) — see `PutPolicyOverrideRequest`'s doc comment in wire/types.ts.
 */
export function PolicyOverridesSection() {
  const overridesQ = useMyPolicyOverrides();
  const overrides = overridesQ.data?.overrides ?? [];
  const del = useDeleteMyPolicyOverride();
  const put = usePutMyPolicyOverride();

  const [targetKind, setTargetKind] = useState<TargetKind>("service");
  const [service, setService] = useState("");
  const [actionId, setActionId] = useState("");
  const [riskLevel, setRiskLevel] = useState<RiskLevelWire>("low");
  const [mode, setMode] = useState<ApprovalModeWire>("allow");
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const canSubmit =
    (targetKind === "service" && service.trim().length > 0) ||
    (targetKind === "actionId" && actionId.trim().length > 0) ||
    targetKind === "riskLevel";

  function submit() {
    setError(null);
    const target =
      targetKind === "service" ? { service } : targetKind === "actionId" ? { actionId } : { riskLevel };
    put.mutate(
      { ...target, mode },
      {
        onSuccess: () => {
          setService("");
          setActionId("");
        },
        onError: (err) => setError(apiErrorMessage(err)),
      },
    );
  }

  return (
    <div className="space-y-10">
      <Section title="My policy overrides" description="Your own overrides on top of org policy.">
        {overridesQ.isLoading && <p className="py-4 text-sm text-muted">Loading…</p>}
        {!overridesQ.isLoading && overrides.length === 0 && (
          <p className="py-4 text-sm text-muted">No overrides yet.</p>
        )}
        {overrides.map((o) => (
          <div key={o.id} className="flex items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-[--fg]">{targetLabel(o)}</span>
                <Badge variant={MODE_BADGE[o.mode]}>{o.mode}</Badge>
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Delete override ${targetLabel(o)}`}
              disabled={del.isPending}
              onClick={() => {
                setRowError(null);
                del.mutate(
                  { service: o.service ?? undefined, actionId: o.actionId ?? undefined, riskLevel: o.riskLevel ?? undefined },
                  { onError: (err) => setRowError(apiErrorMessage(err)) },
                );
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        {rowError && <p className="pb-2 text-xs text-danger-500">{rowError}</p>}
      </Section>

      <Section title="New override" description="Choose exactly one target: service, action, or risk level.">
        <div className="space-y-4 py-4">
          <fieldset className="flex flex-wrap gap-4" aria-label="Target">
            {(["service", "actionId", "riskLevel"] as const).map((kind) => (
              <label key={kind} className="flex items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  name="override-target-kind"
                  value={kind}
                  checked={targetKind === kind}
                  onChange={() => setTargetKind(kind)}
                />
                {kind === "service" ? "Service" : kind === "actionId" ? "Action" : "Risk level"}
              </label>
            ))}
          </fieldset>

          {targetKind === "service" && (
            <div>
              <Label htmlFor="override-service">Service</Label>
              <div className="mt-1 w-64">
                <ServiceActionCombobox
                  mode="service"
                  id="override-service"
                  value={service}
                  onChange={setService}
                  placeholder="Select or type a service…"
                />
              </div>
            </div>
          )}
          {targetKind === "actionId" && (
            <div>
              <Label htmlFor="override-action">Action id</Label>
              <div className="mt-1 w-64">
                <ServiceActionCombobox
                  mode="action"
                  id="override-action"
                  value={actionId}
                  onChange={setActionId}
                  placeholder="Select or type an action id…"
                />
              </div>
            </div>
          )}
          {targetKind === "riskLevel" && (
            <div>
              <Label htmlFor="override-risk">Risk level</Label>
              <select
                id="override-risk"
                value={riskLevel}
                onChange={(e) => setRiskLevel(e.target.value as RiskLevelWire)}
                className="mt-1 h-9 rounded border border-[--border] bg-[--bg] px-2 text-sm"
              >
                {RISK_LEVELS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <Label htmlFor="override-mode">Mode</Label>
            <select
              id="override-mode"
              value={mode}
              onChange={(e) => setMode(e.target.value as ApprovalModeWire)}
              className="mt-1 h-9 rounded border border-[--border] bg-[--bg] px-2 text-sm"
            >
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>

          {error && <p className="text-sm text-danger-500">{error}</p>}

          <Button type="button" disabled={!canSubmit || put.isPending} onClick={submit}>
            {put.isPending ? "Saving…" : "Save override"}
          </Button>
        </div>
      </Section>
    </div>
  );
}
