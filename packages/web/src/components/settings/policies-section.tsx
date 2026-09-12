import { useMemo, useState } from "react";
import { MODE_LABELS, RISK_LABELS, POLICY_SELECT_CLASS } from "./policy-presentation";
import { Trash2 } from "lucide-react";
import type {
  ApprovalModeWire,
  ParamMatcherWire,
  PluginSummary,
  PolicyAppliesInWire,
  RiskLevelWire,
} from "@valet/api/wire";
import { Badge, Button, ConfirmDialog, Input, Label, Switch } from "~/components/primitives";
import { ServiceActionCombobox } from "./service-action-combobox";
import { Section } from "~/components/settings/section";
import { usePlugins } from "~/api/integrations";
import {
  apiErrorMessage,
  useCreatePolicy,
  useDeletePolicy,
  usePolicies,
  usePatchPolicy,
} from "~/api/policies";

const RISK_LEVELS: readonly RiskLevelWire[] = ["low", "medium", "high", "critical"];
const MODES: readonly ApprovalModeWire[] = ["allow", "require_approval", "deny"];
const APPLIES_IN: readonly PolicyAppliesInWire[] = ["any", "session", "workflow"];
const MATCHER_OPS = ["eq", "neq", "regex", "in", "not_in", "gt", "gte", "lt", "lte", "exists", "not_exists"] as const;

const RUN_LABELS: Record<PolicyAppliesInWire, string> = {
  any: "All runs", session: "Chats", workflow: "Workflows",
};

const OP_LABELS: Record<ParamMatcherWire["op"], string> = {
  eq: "Equals", neq: "Does not equal", regex: "Matches pattern", in: "Is one of", not_in: "Is not one of",
  gt: "Greater than", gte: "At least", lt: "Less than", lte: "At most", exists: "Exists", not_exists: "Does not exist",
};
const NUMERIC_MATCHER_OPS = new Set<ParamMatcherWire["op"]>(["gt", "gte", "lt", "lte"]);
const LIST_MATCHER_OPS = new Set<ParamMatcherWire["op"]>(["in", "not_in"]);

/**
 * The matcher-row editor stores the typed value as a plain string
 * regardless of op (so switching a row's op never loses or garbles what's
 * typed); this converts that raw string into the shape the API's matcher
 * engine (`packages/api/src/policies/matchers.ts`) actually requires per
 * op — `evaluateMatcher` silently returns `false` for gt/gte/lt/lte unless
 * both sides are `number` (a matcher created with a string `value` there is
 * NOT a validation error, it's a policy that quietly never matches), and
 * `validateParamMatchers` 400s in/not_in unless `value` is an array.
 */
export type MatcherValueResult =
  | { ok: true; value: string | number | string[] }
  | { ok: false; error: string };

export function matcherValueForOp(op: ParamMatcherWire["op"], raw: string): MatcherValueResult {
  if (NUMERIC_MATCHER_OPS.has(op)) {
    const trimmed = raw.trim();
    const n = Number(trimmed);
    if (trimmed.length === 0 || !Number.isFinite(n)) {
      return { ok: false, error: `Matcher value must be a number for op "${op}"` };
    }
    return { ok: true, value: n };
  }
  if (LIST_MATCHER_OPS.has(op)) {
    const items = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (items.length === 0) {
      return { ok: false, error: `Matcher value must be a comma-separated list for op "${op}"` };
    }
    return { ok: true, value: items };
  }
  return { ok: true, value: raw };
}

type TargetKind = "service" | "actionId" | "riskLevel";

const MODE_BADGE: Record<ApprovalModeWire, "success" | "accent" | "danger"> = {
  allow: "success",
  require_approval: "accent",
  deny: "danger",
};

/**
 * Organization and team Policies share the target and matcher forms. A catalog browser
 * over `/api/plugins` (service/action targets), per-service kill switches
 * (service-level `deny`/`any` policy rows) and owner-scoped CRUD.
 * Target is exactly-one-of service/actionId/riskLevel, matching the API's
 * 400-on-violation contract.
 */
export function PoliciesSection({ teamId, canEdit = true, variant = "full" }: { teamId?: string; canEdit?: boolean; variant?: "full" | "advanced" }) {
  const title = teamId === undefined ? "Policies" : "Action rules";
  const policiesQ = usePolicies(teamId);
  const pluginsQ = usePlugins();
  const rows = policiesQ.data?.policies ?? [];
  const policies = variant === "advanced" ? rows.filter(p => p.appliesIn !== "any" || p.paramMatchers.length > 0 || p.expiresAt !== null) : rows;
  const plugins = pluginsQ.data?.plugins ?? [];

  // A failed team refetch must remove stale rows and any open editor.
  if (teamId !== undefined && (policiesQ.error || !policiesQ.data)) {
    return <Section title={title}>
      <p role={policiesQ.error ? "alert" : "status"} className="py-4 text-sm text-muted">
        {policiesQ.error ? "Could not load team policies. Reload to check your access." : "Loading team policies…"}
      </p>
    </Section>;
  }

  return (
    <div className="space-y-10">
      {variant === "full" && <KillSwitches plugins={plugins} policies={policies} teamId={teamId} canEdit={canEdit} />}
      <Section title={title} description={teamId === undefined
        ? "Rules the resolver applies before an action runs."
        : "Rules for actions run by this team. Organization policies still apply."}>
        {policiesQ.isLoading && <p className="py-4 text-sm text-muted">Loading…</p>}
        {policiesQ.error && <p className="py-4 text-sm text-danger-500">Failed to load policies.</p>}
        {!policiesQ.isLoading && policies.length === 0 && (
          <p className="py-4 text-sm text-muted">No policies yet.</p>
        )}
        {policies.map((p) => (
          <PolicyRow key={p.id} policy={p} teamId={teamId} canEdit={canEdit} showConditions={variant === "advanced"} />
        ))}
      </Section>
      {teamId !== undefined && !canEdit && <p className="text-sm text-muted">Only team admins can change policies.</p>}
      {teamId !== undefined && pluginsQ.error && <p role="alert">Could not load the action catalog. Reload to try again.</p>}
      {canEdit && <NewPolicyForm plugins={plugins} teamId={teamId} />}
    </div>
  );
}

function targetLabel(p: {
  service: string | null;
  actionId: string | null;
  riskLevel: RiskLevelWire | null;
}): string {
  if (p.actionId) return `action: ${p.actionId}`;
  if (p.riskLevel) return `risk: ${p.riskLevel}`;
  if (p.service) return `service: ${p.service}`;
  return "(no target)";
}

function PolicyRow({
  policy, teamId, canEdit, showConditions = false,
}: {
  teamId?: string;
  canEdit: boolean;
  showConditions?: boolean;
  policy: {
    paramMatchers?: ParamMatcherWire[];
    id: string;
    service: string | null;
    actionId: string | null;
    riskLevel: RiskLevelWire | null;
    mode: ApprovalModeWire;
    appliesIn: PolicyAppliesInWire;
    expiresAt: number | null;
  };
}) {
  const del = useDeletePolicy(teamId);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  function remove() {
    if (!canEdit) return;
    setError(null);
    del.mutate(policy.id, {
      onSuccess: () => setConfirmDelete(false),
      onError: (err) => setError(apiErrorMessage(err)),
    });
  }

  return (
    <div className="flex flex-wrap items-start gap-3 py-4">
      <div className="min-w-0 basis-full sm:flex-1 sm:basis-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 break-words text-sm font-medium text-[--fg] [overflow-wrap:anywhere]">{targetLabel(policy)}</span>
          <Badge variant={MODE_BADGE[policy.mode]}>{MODE_LABELS[policy.mode]}</Badge>
          <Badge variant="neutral">{RUN_LABELS[policy.appliesIn]}</Badge>
        </div>
        {showConditions && (policy.paramMatchers?.length ?? 0) > 0 && <pre className="mt-2 whitespace-pre-wrap break-all text-xs text-muted">{JSON.stringify(policy.paramMatchers, null, 2)}</pre>}
        {policy.expiresAt !== null && (
          <p className="mt-0.5 text-xs text-muted">
            Expires {new Date(policy.expiresAt).toLocaleString()}
          </p>
        )}
        {error && <p className="mt-1 text-xs text-danger-500">{error}</p>}
      </div>
      {teamId !== undefined && <TeamPolicyMode teamId={teamId} id={policy.id} mode={policy.mode} canEdit={canEdit} />}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Delete policy ${targetLabel(policy)}`}
        disabled={!canEdit || del.isPending}
        onClick={() => {
          if (teamId === undefined) remove();
          else { setError(null); setConfirmDelete(true); }
        }}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
      {teamId !== undefined && <ConfirmDialog open={confirmDelete && canEdit} onOpenChange={setConfirmDelete}
        title="Delete team policy?" description={`Remove the rule for ${targetLabel(policy)} from this team.`}
        confirmLabel="Delete policy" pending={del.isPending} error={error} onConfirm={remove} />}
    </div>
  );
}

function TeamPolicyMode({ teamId, id, mode, canEdit }: {
  teamId: string; id: string; mode: ApprovalModeWire; canEdit: boolean;
}) {
  const patch = usePatchPolicy(teamId);
  return <div className="min-w-0 flex-1 sm:max-w-48">
    <select className={POLICY_SELECT_CLASS}
      aria-label={`Mode for policy ${id}`} value={mode} disabled={!canEdit || patch.isPending}
      onChange={(event) => {
        const mode = MODES.find((value) => value === event.target.value);
        if (mode) patch.mutate({ id, body: { mode } });
      }}>
      {MODES.map((mode) => <option key={mode} value={mode}>{MODE_LABELS[mode]}</option>)}
    </select>
    {patch.error && <p role="alert" className="text-sm text-danger-500">{apiErrorMessage(patch.error)}</p>}
  </div>;
}

function KillSwitches({
  plugins,
  policies, teamId, canEdit,
}: {
  plugins: PluginSummary[];
  teamId?: string;
  canEdit: boolean;
  policies: Array<{
    id: string;
    service: string | null;
    actionId: string | null;
    riskLevel: RiskLevelWire | null;
    mode: ApprovalModeWire;
    appliesIn: PolicyAppliesInWire;
  }>;
}) {
  const create = useCreatePolicy(teamId);
  const del = useDeletePolicy(teamId);
  const [error, setError] = useState<string | null>(null);

  const services = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const plugin of plugins) {
      for (const svc of plugin.services) {
        if (!seen.has(svc.service)) {
          seen.add(svc.service);
          out.push(svc.service);
        }
      }
    }
    return out;
  }, [plugins]);

  if (services.length === 0) return null;

  function killSwitchRow(service: string) {
    return policies.find(
      (p) =>
        p.service === service &&
        p.actionId === null &&
        p.riskLevel === null &&
        p.appliesIn === "any" &&
        p.mode === "deny",
    );
  }

  return (
    <Section
      title="Kill switches"
      description={teamId === undefined
        ? "Instantly deny every action for a service — sugar over a service-level deny policy."
        : "Block this team’s actions for a service."}
    >
      {services.map((service) => {
        const row = killSwitchRow(service);
        return (
          <div key={service} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <span className="text-sm font-medium text-[--fg]">{service}</span>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted">{row ? "Blocked" : teamId === undefined ? "Allowed" : "No team block"}</span>
              <Switch
                aria-label={`Kill switch for ${service}`}
                checked={row !== undefined}
                disabled={!canEdit || create.isPending || del.isPending}
                onCheckedChange={() => {
                  setError(null);
                  if (row) {
                    del.mutate(row.id, { onError: (err) => setError(apiErrorMessage(err)) });
                  } else {
                    create.mutate(
                      { service, mode: "deny", appliesIn: "any" },
                      { onError: (err) => setError(apiErrorMessage(err)) },
                    );
                  }
                }}
              />
            </div>
          </div>
        );
      })}
      {error && <p className="pb-2 text-xs text-danger-500">{error}</p>}
    </Section>
  );
}

interface MatcherRow {
  key: string;
  path: string;
  op: ParamMatcherWire["op"];
  value: string;
}

function NewPolicyForm({ plugins, teamId }: { plugins: PluginSummary[]; teamId?: string }) {
  const create = useCreatePolicy(teamId);
  const [targetKind, setTargetKind] = useState<TargetKind>("service");
  const [service, setService] = useState("");
  const [actionId, setActionId] = useState("");
  const [riskLevel, setRiskLevel] = useState<RiskLevelWire>("low");
  const [mode, setMode] = useState<ApprovalModeWire>("require_approval");
  const [appliesIn, setAppliesIn] = useState<PolicyAppliesInWire>("any");
  const [matchers, setMatchers] = useState<MatcherRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const serviceOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const plugin of plugins) {
      for (const svc of plugin.services) {
        if (!seen.has(svc.service)) {
          seen.add(svc.service);
          out.push(svc.service);
        }
      }
    }
    return out;
  }, [plugins]);

  const actionOptions = useMemo(() => {
    const out: { id: string; name: string }[] = [];
    for (const plugin of plugins) {
      for (const svc of plugin.services) {
        for (const a of svc.actions) {
          out.push({ id: a.id, name: a.name });
        }
      }
    }
    return out;
  }, [plugins]);

  function addMatcherRow() {
    setMatchers([...matchers, { key: crypto.randomUUID(), path: "", op: "eq", value: "" }]);
  }
  function removeMatcherRow(key: string) {
    setMatchers(matchers.filter((m) => m.key !== key));
  }
  function updateMatcherRow(key: string, patch: Partial<MatcherRow>) {
    setMatchers(matchers.map((m) => (m.key === key ? { ...m, ...patch } : m)));
  }

  function submit() {
    setError(null);
    const paramMatchers: ParamMatcherWire[] = [];
    for (const m of matchers.filter((row) => row.path.trim().length > 0)) {
      const result = matcherValueForOp(m.op, m.value);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      paramMatchers.push({ path: m.path.trim(), op: m.op, value: result.value });
    }

    const target =
      targetKind === "service"
        ? { service }
        : targetKind === "actionId"
          ? { actionId }
          : { riskLevel };

    create.mutate(
      {
        ...target,
        mode,
        appliesIn,
        paramMatchers: paramMatchers.length > 0 ? paramMatchers : undefined,
      },
      {
        onSuccess: () => {
          setService("");
          setActionId("");
          setMatchers([]);
        },
        onError: (err) => setError(apiErrorMessage(err)),
      },
    );
  }

  const canSubmit =
    (targetKind === "service" && service.trim().length > 0) ||
    (targetKind === "actionId" && actionId.trim().length > 0) ||
    targetKind === "riskLevel";

  return (
    <Section title="New policy" description="Choose exactly one target: service, action, or risk level.">
      <div className="space-y-4 py-4">
        <fieldset className="flex flex-wrap gap-4" aria-label="Target">
          {(["service", "actionId", "riskLevel"] as const).map((kind) => (
            <label key={kind} className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name="policy-target-kind"
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
            <Label htmlFor="policy-service">Service</Label>
            <div className="mt-1">
              <ServiceActionCombobox
                mode="service"
                id="policy-service"
                value={service}
                onChange={setService}
                placeholder="Select or type a service…"
              />
            </div>
          </div>
        )}

        {targetKind === "actionId" && (
          <div>
            <Label htmlFor="policy-action">Action</Label>
            <div className="mt-1">
              <ServiceActionCombobox
                mode="action"
                id="policy-action"
                value={actionId}
                onChange={setActionId}
                placeholder="Select or type an action id…"
              />
            </div>
          </div>
        )}

        {targetKind === "riskLevel" && (
          <div>
            <Label htmlFor="policy-risk">Risk level</Label>
            <select
              id="policy-risk"
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

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="policy-mode">Mode</Label>
            <select
              id="policy-mode"
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
          <div>
            <Label htmlFor="policy-applies-in">Applies in</Label>
            <select
              id="policy-applies-in"
              value={appliesIn}
              onChange={(e) => setAppliesIn(e.target.value as PolicyAppliesInWire)}
              className={`mt-1 ${POLICY_SELECT_CLASS}`}
            >
              {APPLIES_IN.map((a) => (
                <option key={a} value={a}>
                  {RUN_LABELS[a]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">Conditions</span>
            <Button type="button" variant="secondary" size="sm" onClick={addMatcherRow}>
              Add condition
            </Button>
          </div>
          <p className="text-xs text-muted">Optionally match action inputs to limit when this rule applies.</p>
          {matchers.map((m) => (
            <div key={m.key} className="grid min-w-0 grid-cols-1 gap-2 rounded border border-line p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-start">
              <Input
                aria-label="Matcher path"
                placeholder="Input path, e.g. issue.priority"
                value={m.path}
                onChange={(e) => updateMatcherRow(m.key, { path: e.target.value })}
                className="w-full min-w-0"
              />
              <select
                aria-label="Matcher operator"
                value={m.op}
                onChange={(e) => updateMatcherRow(m.key, { op: e.target.value as ParamMatcherWire["op"] })}
                className={POLICY_SELECT_CLASS}
              >
                {MATCHER_OPS.map((op) => (
                  <option key={op} value={op}>
                    {OP_LABELS[op]}
                  </option>
                ))}
              </select>
              <Input
                aria-label="Matcher value"
                type={NUMERIC_MATCHER_OPS.has(m.op) ? "number" : "text"}
                placeholder={
                  NUMERIC_MATCHER_OPS.has(m.op)
                    ? "0"
                    : LIST_MATCHER_OPS.has(m.op)
                      ? "a, b, c"
                      : "value"
                }
                value={m.value}
                onChange={(e) => updateMatcherRow(m.key, { value: e.target.value })}
                className="w-full min-w-0"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Remove condition"
                onClick={() => removeMatcherRow(m.key)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>

        {error && <p className="text-sm text-danger-500">{error}</p>}

        <Button type="button" disabled={!canSubmit || create.isPending} onClick={submit}>
          {create.isPending ? "Creating…" : "Create policy"}
        </Button>
      </div>
    </Section>
  );
}
