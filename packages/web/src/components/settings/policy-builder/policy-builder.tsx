import { useId, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { AlertTriangle, Plus, RotateCcw, Trash2 } from "lucide-react";
import { AUTHORIZATION_CONTEXT_KINDS, POLICY_CONTEXTS, createPreviewRequest, validatePolicyDraft, type AuthorizationKind, type ComparisonOperator, type PolicyDraftV1, type PolicyPreviewProvider, type PolicyPreviewResultV1 } from "@valet/api/policy-builder";
import { Badge, Button, Input, Label, Textarea } from "~/components/primitives";
import { fixturePolicyPreviewProvider } from "./preview-provider";

const SELECT = "h-9 w-full rounded border border-[--border] bg-[--bg] px-3 text-sm text-[--fg] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss";
const safeId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
function emptyDraft(context: AuthorizationKind, owner: { kind: "org" | "team"; id: string }): PolicyDraftV1 {
  const descriptor = POLICY_CONTEXTS[context];
  const target = descriptor.fields.find((field) => field.location === "target" && field.sensitivity === "public");
  const condition = descriptor.fields.find((field) => field.location !== "target" && field.sensitivity === "public");
  return {
    schemaVersion: 1,
    draftId: safeId(),
    rules: [
      {
        ruleId: safeId(),
        context,
        authority: owner.kind === "org" ? "organization" : "team",
        owner,
        subjects: [owner.kind],
        target: target ? { [target.path]: "" } : {},
        matcherGroups: [
          {
            id: safeId(),
            mode: "all",
            matchers: condition
              ? [
                  {
                    id: safeId(),
                    field: condition.path.endsWith(".*") ? `${condition.path.slice(0, -1)}value` : condition.path,
                    operator: condition.operators[0],
                    value: "",
                  },
                ]
              : [],
          },
        ],
        effect: descriptor.fallback,
        appliesIn: descriptor.appliesIn ? "any" : undefined,
        approval: descriptor.fallback === "require_approval" ? { tier: "human", replay: "once" } : undefined,
        obligations: [],
        description: "",
        metadata: {},
      },
    ],
  };
}

export function PolicyBuilder({ owner, provider = fixturePolicyPreviewProvider }: { owner: { kind: "org" | "team"; id: string }; provider?: PolicyPreviewProvider }) {
  const heading = useId(),
    [draft, setDraft] = useState(() => emptyDraft("tool.action", owner));
  const [preview, setPreview] = useState<PolicyPreviewResultV1 | null>(null),
    [selectedRule, setSelectedRule] = useState<string | null>(null),
    firstField = useRef<HTMLInputElement>(null);
  const rule = draft.rules[0],
    descriptor = POLICY_CONTEXTS[rule.context],
    issues = useMemo(() => validatePolicyDraft(draft), [draft]);
  const update = (patch: Partial<typeof rule>) => {
    setPreview(null);
    setDraft((value) => ({
      ...value,
      rules: [{ ...value.rules[0], ...patch }],
    }));
  };
  const changeContext = (context: AuthorizationKind) => {
    setPreview(null);
    setSelectedRule(null);
    setDraft(emptyDraft(context, owner));
    queueMicrotask(() => firstField.current?.focus());
  };
  const group = rule.matcherGroups[0];
  async function runPreview() {
    if (!descriptor.publishable) {
      setPreview({
        status: "unsupported",
        issues: [
          {
            code: "unsupported_authorization_context",
            path: "rules[0].context",
            message: "Backend source support is not available. Select Tool and action to preview.",
          },
        ],
      });
      return;
    }
    if (issues.length) {
      setPreview({ status: "invalid", issues });
      return;
    }
    setPreview(await provider.preview(createPreviewRequest(draft, {})));
  }
  return (
    <section aria-labelledby={heading} className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id={heading} className="font-display text-xl text-ink">
            Canonical policy builder
          </h2>
          <p className="text-sm text-muted">Create an in-memory draft and preview canonical Rego v1. This draft is not saved or active.</p>
        </div>
        <Badge variant="warning">Preview only</Badge>
      </div>
      <div className="grid gap-6 border-t border-line py-5 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.9fr)]">
        <div className="space-y-5">
          <Field label="Authorization context" id="policy-context">
            <select id="policy-context" className={SELECT} value={rule.context} onChange={(event) => changeContext(event.target.value as AuthorizationKind)}>
              {AUTHORIZATION_CONTEXT_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {POLICY_CONTEXTS[kind].label} ({kind}){POLICY_CONTEXTS[kind].publishable ? "" : " - preview unavailable"}
                </option>
              ))}
            </select>
          </Field>
          {!descriptor.publishable && (
            <p role="alert" className="flex gap-2 text-sm text-warning-fg">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              Backend source support is not available for {rule.context}. Preview fails closed.
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Authority" id="policy-authority">
              <Input id="policy-authority" value={rule.authority} readOnly />
            </Field>
            <Field label="Owner" id="policy-owner">
              <Input id="policy-owner" value={`${owner.kind}:${owner.id}`} readOnly />
            </Field>
          </div>
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium text-ink">Target</legend>
            {descriptor.fields
              .filter((field) => field.location === "target")
              .map((field, index) => (
                <Field key={field.path} label={`${field.label}${field.sensitivity === "public" ? "" : " (reference only)"}`} id={`target-${index}`}>
                  <Input
                    ref={index === 0 ? (firstField as Ref<HTMLInputElement>) : undefined}
                    id={`target-${index}`}
                    disabled={field.sensitivity !== "public"}
                    placeholder={field.sensitivity === "public" ? field.type : "Sensitive value hidden"}
                    value={String(rule.target[field.path] ?? "")}
                    onChange={(event) =>
                      update({
                        target: {
                          [field.path]: field.type === "number" ? Number(event.target.value) : event.target.value,
                        },
                      })
                    }
                  />
                </Field>
              ))}
          </fieldset>
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium text-ink">Conditions</legend>
            {group.matchers.map((matcher, index) => {
              const field = descriptor.fields.find((item) => item.path === matcher.field) ?? descriptor.fields.find((item) => item.path.endsWith(".*"));
              return (
                <div key={matcher.id} className="grid gap-2 sm:grid-cols-[1fr_10rem_1fr_auto]">
                  <select
                    aria-label={`Condition ${index + 1} field`}
                    className={SELECT}
                    value={matcher.field}
                    onChange={(event) =>
                      update({
                        matcherGroups: [
                          {
                            ...group,
                            matchers: group.matchers.map((item) =>
                              item.id === matcher.id
                                ? {
                                    ...item,
                                    field: event.target.value,
                                    operator: POLICY_CONTEXTS[rule.context].fields.find((candidate) => candidate.path === event.target.value)?.operators[0] ?? "eq",
                                    value: "",
                                  }
                                : item,
                            ),
                          },
                        ],
                      })
                    }
                  >
                    {descriptor.fields
                      .filter((item) => item.location !== "target")
                      .map((item) => (
                        <option key={item.path} value={item.path.endsWith(".*") ? `${item.path.slice(0, -1)}value` : item.path}>
                          {item.label}
                          {item.sensitivity === "public" ? "" : " (blocked)"}
                        </option>
                      ))}
                  </select>
                  <select
                    aria-label={`Condition ${index + 1} operator`}
                    className={SELECT}
                    value={matcher.operator}
                    onChange={(event) =>
                      update({
                        matcherGroups: [
                          {
                            ...group,
                            matchers: group.matchers.map((item) =>
                              item.id === matcher.id
                                ? {
                                    ...item,
                                    operator: event.target.value as ComparisonOperator,
                                  }
                                : item,
                            ),
                          },
                        ],
                      })
                    }
                  >
                    {field?.operators.map((operator) => (
                      <option key={operator}>{operator}</option>
                    ))}
                  </select>
                  <Input
                    aria-label={`Condition ${index + 1} value`}
                    disabled={field?.sensitivity !== "public" || ["exists", "not_exists"].includes(matcher.operator)}
                    type={field?.type === "number" || field?.type === "timestamp" ? "number" : "text"}
                    placeholder={field?.sensitivity === "public" ? "Value" : "Sensitive value hidden"}
                    value={typeof matcher.value === "string" || typeof matcher.value === "number" ? matcher.value : ""}
                    onChange={(event) =>
                      update({
                        matcherGroups: [
                          {
                            ...group,
                            matchers: group.matchers.map((item) =>
                              item.id === matcher.id
                                ? {
                                    ...item,
                                    value: field?.type === "number" ? Number(event.target.value) : event.target.value,
                                  }
                                : item,
                            ),
                          },
                        ],
                      })
                    }
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove condition ${index + 1}`}
                    onClick={() =>
                      update({
                        matcherGroups: [
                          {
                            ...group,
                            matchers: group.matchers.filter((item) => item.id !== matcher.id),
                          },
                        ],
                      })
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const field = descriptor.fields.find((item) => item.location !== "target" && item.sensitivity === "public");
                if (field)
                  update({
                    matcherGroups: [
                      {
                        ...group,
                        matchers: [
                          ...group.matchers,
                          {
                            id: safeId(),
                            field: field.path,
                            operator: field.operators[0],
                            value: "",
                          },
                        ],
                      },
                    ],
                  });
              }}
            >
              <Plus className="h-4 w-4" />
              Add condition
            </Button>
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Effect" id="policy-effect">
              <select
                id="policy-effect"
                className={SELECT}
                value={rule.effect}
                onChange={(event) => {
                  const effect = event.target.value as typeof rule.effect;
                  update({
                    effect,
                    approval: effect === "require_approval" ? { tier: "human", replay: "once" } : undefined,
                  });
                }}
              >
                {descriptor.effects.map((effect) => (
                  <option key={effect}>{effect}</option>
                ))}
              </select>
            </Field>
            {descriptor.appliesIn && (
              <Field label="Applies in" id="policy-applies">
                <select
                  id="policy-applies"
                  className={SELECT}
                  value={rule.appliesIn}
                  onChange={(event) =>
                    update({
                      appliesIn: event.target.value as "any" | "session" | "workflow",
                    })
                  }
                >
                  <option>any</option>
                  <option>session</option>
                  <option>workflow</option>
                </select>
              </Field>
            )}
          </div>
          {rule.effect === "require_approval" && (
            <Field label="Approval tier" id="approval-tier">
              <Input
                id="approval-tier"
                value={rule.approval?.tier ?? ""}
                onChange={(event) =>
                  update({
                    approval: { tier: event.target.value, replay: "once" },
                  })
                }
              />
            </Field>
          )}
          <Field label="Obligations and redactions" id="policy-obligation">
            <select
              id="policy-obligation"
              className={SELECT}
              value={rule.obligations[0]?.type ?? ""}
              onChange={(event) =>
                update({
                  obligations: event.target.value
                    ? [
                        {
                          type: event.target.value as (typeof rule.obligations)[number]["type"],
                        },
                      ]
                    : [],
                })
              }
            >
              <option value="">None</option>
              {descriptor.obligations.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </Field>
          <Field label="Expiry" id="policy-expiry">
            <Input
              id="policy-expiry"
              type="datetime-local"
              onChange={(event) =>
                update({
                  expiresAtMs: event.target.value ? new Date(event.target.value).getTime() : undefined,
                })
              }
            />
          </Field>
          <Field label="Description" id="policy-description">
            <Textarea id="policy-description" value={rule.description} onChange={(event) => update({ description: event.target.value })} />
          </Field>
          <div aria-live="polite" role={issues.length ? "alert" : "status"} className="text-sm">
            <strong>{issues.length ? `${issues.length} validation issue${issues.length === 1 ? "" : "s"}` : "Draft structure is valid"}</strong>
            {issues.slice(0, 4).map((issue) => (
              <p key={`${issue.path}-${issue.code}`} className="text-danger-500">
                {issue.path}: {issue.message}
              </p>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void runPreview()}>Preview and validate</Button>
            <Button variant="ghost" onClick={() => changeContext(rule.context)}>
              <RotateCcw className="h-4 w-4" />
              Reset draft
            </Button>
          </div>
        </div>
        <Preview result={preview} selectedRule={selectedRule} onSelect={setSelectedRule} />
      </div>
    </section>
  );
}
function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}
function Preview({ result, selectedRule, onSelect }: { result: PolicyPreviewResultV1 | null; selectedRule: string | null; onSelect: (id: string) => void }) {
  if (!result)
    return (
      <aside aria-label="Source preview" className="min-h-48 border-l-0 border-line lg:border-l lg:pl-6">
        <p className="text-sm text-muted">Run preview to inspect generated source and declared provenance ranges.</p>
      </aside>
    );
  if (result.status !== "ready")
    return (
      <aside aria-label="Source preview" role="alert" className="text-sm text-danger-500">
        {result.issues.map((issue) => (
          <p key={`${issue.path}-${issue.code}`}>{issue.message}</p>
        ))}
      </aside>
    );
  const lines = result.rego.split("\n"),
    range = result.ranges.find((item) => item.ruleId === selectedRule);
  return (
    <aside aria-label="Source preview" className="min-w-0 space-y-4 border-line lg:border-l lg:pl-6">
      <div>
        <h3 className="font-medium text-ink">Generated Rego v1</h3>
        <p className="text-xs text-muted">Read-only fixture through the preview provider. No browser evaluator or execution trace.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {result.ranges.map((item) => (
          <Button key={item.ruleId} size="sm" variant={selectedRule === item.ruleId ? "secondary" : "ghost"} onClick={() => onSelect(item.ruleId)}>
            Show {item.ruleId}
          </Button>
        ))}
      </div>
      <pre tabIndex={0} aria-label="Generated Rego source" className="max-h-[32rem] overflow-auto rounded border border-line bg-neutral-50 p-3 text-xs text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
        {lines.map((line, index) => (
          <span key={index} data-highlighted={(range && index + 1 >= range.startLine && index + 1 <= range.endLine) || undefined} className={range && index + 1 >= range.startLine && index + 1 <= range.endLine ? "block bg-moss-wash" : "block"}>
            {String(index + 1).padStart(3)} {line}
          </span>
        ))}
      </pre>
      <details>
        <summary className="cursor-pointer text-sm font-medium">Canonical data</summary>
        <pre className="mt-2 overflow-auto text-xs">{result.data}</pre>
      </details>
      {result.usage && (
        <p className="text-xs text-muted">
          Work: {result.usage.workUnits} of {result.usage.workLimit}
        </p>
      )}
    </aside>
  );
}
