import { useState } from "react";
import { MODE_LABELS, RISK_LABELS, POLICY_SELECT_CLASS } from "./policy-presentation";
import { Trash2 } from "lucide-react";
import type { ActionPolicyOverrideWire, PutPolicyOverrideRequest, ApprovalModeWire, RiskLevelWire } from "@valet/api/wire";
import { Badge, Button, ConfirmDialog, Label } from "~/components/primitives";
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
  const del = useDeleteMyPolicyOverride();
  const put = usePutMyPolicyOverride();
  if (overridesQ.error) return <p role="alert">{apiErrorMessage(overridesQ.error)}</p>;
  if (!overridesQ.data) return <p role="status">Loading…</p>;
  return <PolicyOverridesEditor overrides={overridesQ.data.overrides} title="My policy overrides"
    description="Your own overrides on top of org policy." canEdit saving={put.isPending} deleting={del.isPending}
    save={body => put.mutateAsync(body)} remove={row => del.mutateAsync({ service: row.service ?? undefined, actionId: row.actionId ?? undefined, riskLevel: row.riskLevel ?? undefined })} />;
}

export interface PolicyOverridesEditorProps {
  overrides: ActionPolicyOverrideWire[];
  title: string;
  description: string;
  canEdit: boolean;
  saving: boolean;
  deleting: boolean;
  save: (body: PutPolicyOverrideRequest) => Promise<unknown>;
  remove: (row: ActionPolicyOverrideWire) => Promise<unknown>;
}

/** Shared personal/team interaction; the adapter supplies only scoped data and mutations. */
export function PolicyOverridesEditor({ overrides, title, description, canEdit, saving, deleting, save, remove }: PolicyOverridesEditorProps) {
  const [selected, setSelected] = useState<ActionPolicyOverrideWire | null>(null);
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
    if (!canEdit) return;
    void save({ ...target, mode }).then(() => { setService(""); setActionId(""); }, err => setError(apiErrorMessage(err)));
  }

  return (
    <div className="space-y-10">
      <Section title={title} description={description}>
        {overrides.length === 0 && <p className="py-4 text-sm text-muted">No overrides yet.</p>}
        {overrides.map((o) => (
          <div key={o.id} className="flex items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 break-words">
                <span className="text-sm font-medium text-[--fg]">{targetLabel(o)}</span>
                <Badge variant={MODE_BADGE[o.mode]}>{MODE_LABELS[o.mode]}</Badge>
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Delete override ${targetLabel(o)}`}
              disabled={!canEdit || deleting}
              onClick={() => {
                setRowError(null);
                if (canEdit) setSelected(o);
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        {rowError && <p className="pb-2 text-xs text-danger-500">{rowError}</p>}
      </Section>

      {!canEdit && <p className="text-sm text-muted">Only team admins can change overrides and revoke grants.</p>}
      <ConfirmDialog open={selected !== null && canEdit} onOpenChange={open => { if (!open) setSelected(null); }}
        title="Delete override?" description="Remove this override and use the remaining policy rules." confirmLabel="Delete override"
        pending={deleting} error={rowError} onConfirm={() => {
          if (selected && canEdit) void remove(selected).then(() => setSelected(null), err => setRowError(apiErrorMessage(err)));
        }} />
      {canEdit && <Section title="New override" description="Choose exactly one target: service, action, or risk level.">
        <div className="space-y-4 py-4">
          <fieldset className="flex flex-wrap gap-4" aria-label="Target">
            {(["service", "actionId", "riskLevel"] as const).map((kind) => (
              <label key={kind} className="flex min-h-11 items-center gap-1.5 text-sm sm:min-h-0">
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
              <div className="mt-1 w-full sm:max-w-sm">
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
              <div className="mt-1 w-full sm:max-w-sm">
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
                className={`mt-1 ${POLICY_SELECT_CLASS}`}
              >
                {RISK_LEVELS.map((r) => (
                  <option key={r} value={r}>
                    {RISK_LABELS[r]}
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
              className={`mt-1 ${POLICY_SELECT_CLASS}`}
            >
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {MODE_LABELS[m]}
                </option>
              ))}
            </select>
          </div>

          {error && <p className="text-sm text-danger-500">{error}</p>}

          <Button type="button" disabled={!canSubmit || saving} onClick={submit}>
            {saving ? "Saving…" : "Save override"}
          </Button>
        </div>
      </Section>}
    </div>
  );
}
