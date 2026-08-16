import { useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import type {
  ApprovalModeWire,
  ParamMatcherWire,
  PluginSummary,
  PolicyAppliesInWire,
  RiskLevelWire,
} from "@valet/api/wire";
import { Badge, Button, Input, Label, Switch } from "~/components/primitives";
import { ServiceActionCombobox } from "./service-action-combobox";
import { Section } from "~/components/settings/section";
import { usePlugins } from "~/api/integrations";
import {
  apiErrorMessage,
  useCreateOrgPolicy,
  useDeleteOrgPolicy,
  useOrgPolicies,
} from "~/api/policies";

const RISK_LEVELS: readonly RiskLevelWire[] = ["low", "medium", "high", "critical"];
const MODES: readonly ApprovalModeWire[] = ["allow", "require_approval", "deny"];
const APPLIES_IN: readonly PolicyAppliesInWire[] = ["any", "session", "workflow"];
const MATCHER_OPS = ["eq", "neq", "regex", "in", "not_in", "gt", "gte", "lt", "lte", "exists", "not_exists"] as const;
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
 * Organization · Policies (action-policies plan, Task 5). A catalog browser
 * over `/api/plugins` (service/action targets), per-service kill switches
 * (sugar over a service-level `deny`/`any` policy row — no dedicated wire
 * concept, identified by target shape), and CRUD over `/api/org/policies`.
 * Target is exactly-one-of service/actionId/riskLevel, matching the API's
 * 400-on-violation contract.
 */
export function PoliciesSection() {
  const policiesQ = useOrgPolicies();
  const pluginsQ = usePlugins();
  const policies = policiesQ.data?.policies ?? [];
  const plugins = pluginsQ.data?.plugins ?? [];

  return (
    <div className="space-y-10">
      <KillSwitches plugins={plugins} policies={policies} />
      <Section title="Policies" description="Rules the resolver applies before an action runs.">
        {policiesQ.isLoading && <p className="py-4 text-sm text-muted">Loading…</p>}
        {policiesQ.error && <p className="py-4 text-sm text-danger-500">Failed to load policies.</p>}
        {!policiesQ.isLoading && policies.length === 0 && (
          <p className="py-4 text-sm text-muted">No policies yet.</p>
        )}
        {policies.map((p) => (
          <PolicyRow key={p.id} policy={p} />
        ))}
      </Section>
      <NewPolicyForm plugins={plugins} />
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
  policy,
}: {
  policy: {
    id: string;
    service: string | null;
    actionId: string | null;
    riskLevel: RiskLevelWire | null;
    mode: ApprovalModeWire;
    appliesIn: PolicyAppliesInWire;
    expiresAt: number | null;
  };
}) {
  const del = useDeleteOrgPolicy();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[--fg]">{targetLabel(policy)}</span>
          <Badge variant={MODE_BADGE[policy.mode]}>{policy.mode}</Badge>
          <Badge variant="neutral">{policy.appliesIn}</Badge>
        </div>
        {policy.expiresAt !== null && (
          <p className="mt-0.5 text-xs text-muted">
            Expires {new Date(policy.expiresAt).toLocaleString()}
          </p>
        )}
        {error && <p className="mt-1 text-xs text-danger-500">{error}</p>}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Delete policy ${targetLabel(policy)}`}
        disabled={del.isPending}
        onClick={() => {
          setError(null);
          del.mutate(policy.id, { onError: (err) => setError(apiErrorMessage(err)) });
        }}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

function KillSwitches({
  plugins,
  policies,
}: {
  plugins: PluginSummary[];
  policies: Array<{
    id: string;
    service: string | null;
    actionId: string | null;
    riskLevel: RiskLevelWire | null;
    mode: ApprovalModeWire;
    appliesIn: PolicyAppliesInWire;
  }>;
}) {
  const create = useCreateOrgPolicy();
  const del = useDeleteOrgPolicy();
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
      description="Instantly deny every action for a service — sugar over a service-level deny policy."
    >
      {services.map((service) => {
        const row = killSwitchRow(service);
        return (
          <div key={service} className="flex items-center justify-between py-3">
            <span className="text-sm font-medium text-[--fg]">{service}</span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted">{row ? "Blocked" : "Allowed"}</span>
              <Switch
                aria-label={`Kill switch for ${service}`}
                checked={row !== undefined}
                disabled={create.isPending || del.isPending}
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

function NewPolicyForm({ plugins }: { plugins: PluginSummary[] }) {
  const create = useCreateOrgPolicy();
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

        <div className="flex gap-4">
          <div>
            <Label htmlFor="policy-mode">Mode</Label>
            <select
              id="policy-mode"
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
          <div>
            <Label htmlFor="policy-applies-in">Applies in</Label>
            <select
              id="policy-applies-in"
              value={appliesIn}
              onChange={(e) => setAppliesIn(e.target.value as PolicyAppliesInWire)}
              className="mt-1 h-9 rounded border border-[--border] bg-[--bg] px-2 text-sm"
            >
              {APPLIES_IN.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Param matchers</Label>
            <Button type="button" variant="secondary" size="sm" onClick={addMatcherRow}>
              Add matcher
            </Button>
          </div>
          {matchers.map((m) => (
            <div key={m.key} className="flex items-center gap-2">
              <Input
                aria-label="Matcher path"
                placeholder="path"
                value={m.path}
                onChange={(e) => updateMatcherRow(m.key, { path: e.target.value })}
                className="w-40"
              />
              <select
                aria-label="Matcher operator"
                value={m.op}
                onChange={(e) => updateMatcherRow(m.key, { op: e.target.value as ParamMatcherWire["op"] })}
                className="h-9 rounded border border-[--border] bg-[--bg] px-2 text-sm"
              >
                {MATCHER_OPS.map((op) => (
                  <option key={op} value={op}>
                    {op}
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
                className="w-40"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Remove matcher"
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
