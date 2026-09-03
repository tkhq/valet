import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { Check } from "lucide-react";
import type { CreateSessionRequest } from "@valet/api/wire";
import { useCreateSession } from "~/api/queries";
import { useSecurityPreview } from "~/api/security";
import { workspaceForRepo } from "~/components/repo-combobox";
import { Button, Label, Spinner } from "~/components/primitives";
import { cn } from "~/lib/cn";
import {
  ConfigForm,
  categoryLabel,
  emptyScopeDraft,
  normalizeScopeHostsForSubmit,
  scopeDraftToWire,
  type ConfigDraft,
} from "~/components/security/config-form";
import {
  PlanStepsEditor,
  draftError,
  draftToInput,
  isPersonaDeterministic,
  planHasLivePersona,
  wireToDraft,
  type StepDraft,
} from "~/components/security/plan-steps-editor";

/** Curated current-gen models for the setup page, mirroring the hub's list. */
const SECURITY_MODELS: readonly { id: string; label: string; note: string }[] = [
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", note: "Recommended" },
  { id: "anthropic/claude-opus-5", label: "Claude Opus 5", note: "Deepest" },
];

function modelLabel(id: string): string {
  return SECURITY_MODELS.find((m) => m.id === id)?.label ?? id;
}

/** One compact plan line for the review step: `authz-sweep · code-review ·
 * authz [triad]`. */
function planLabel(step: StepDraft): string {
  const parts: string[] = [step.name || step.persona];
  if (step.name) parts.push(step.persona);
  if (step.playbook) parts.push(step.playbook);
  let label = parts.join(" · ");
  const flags: string[] = [];
  if (step.triad) flags.push("triad");
  if (step.review) flags.push("verify");
  if (flags.length > 0) label += ` [${flags.join(", ")}]`;
  return label;
}

const WIZARD_STEPS = [
  { id: "focus", label: "Focus" },
  { id: "plan", label: "Plan" },
  // v1 Part 09: the passive "Review" step is now an active launch checklist.
  { id: "review", label: "Launch" },
] as const;

type WizardStep = (typeof WIZARD_STEPS)[number]["id"];

/**
 * `/security/new` — the pre-creation setup page (valet-security design §Web
 * Surfaces, Deviations). The hub passes the repo + preset + model here. This
 * page fetches a read-only preview of the config + plan the review would seed
 * from the repo's `.valet/security.yml` (or the preset fallback), prefills the
 * config form + plan editor, and lets the user edit them. Start review creates
 * the session with the FINAL config + plan and navigates to it. There is no
 * on-session editing and no planning limbo — the review starts running the
 * moment it is created.
 */

/** The search params the hub passes to the setup page. */
export interface SecurityNewSearch {
  repo: string;
  cloneUrl: string;
  preset: string;
  model: string;
  ref?: string;
  /** Comma-joined include globs. */
  paths?: string;
  teamId?: string;
  /** "Include a written report at the end" (Part 08 §Setup Step 1). The hub
   * picker sets this; the setup page threads it into the preview + create.
   * Absent means the hub did not pass one; the preview then falls to the
   * preset's own default (`presetReportDefault`). */
  includeReport?: boolean;
}

function readSearch(raw: Record<string, unknown>): SecurityNewSearch {
  const text = (key: string): string | undefined =>
    typeof raw[key] === "string" && raw[key] !== "" ? (raw[key] as string) : undefined;
  const bool = (key: string): boolean | undefined => {
    const v = raw[key];
    if (typeof v === "boolean") return v;
    if (v === "true") return true;
    if (v === "false") return false;
    return undefined;
  };
  const includeReport = bool("includeReport");
  return {
    repo: text("repo") ?? "",
    cloneUrl: text("cloneUrl") ?? "",
    preset: text("preset") ?? "code-review",
    model: text("model") ?? "",
    ...(text("ref") ? { ref: text("ref") } : {}),
    ...(text("paths") ? { paths: text("paths") } : {}),
    ...(text("teamId") ? { teamId: text("teamId") } : {}),
    ...(includeReport !== undefined ? { includeReport } : {}),
  };
}

export const Route = createFileRoute("/security/new")({
  component: SecurityNewPage,
  validateSearch: (raw: Record<string, unknown>): SecurityNewSearch => readSearch(raw),
});

/** Split the comma/space-joined paths param into include globs. */
function splitPaths(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
}

export function SecurityNewPage() {
  // The top-level hook, not `Route.useSearch()`: the route suite mocks this
  // module and never builds a real router context (the hub suite's pattern).
  const search = readSearch(useSearch({ strict: false }) as Record<string, unknown>);
  const navigate = useNavigate();

  const create = useCreateSession();
  const [model, setModel] = useState(search.model);
  const [config, setConfig] = useState<ConfigDraft>({
    focus: "",
    invariants: [],
    categories: [],
    scope: emptyScopeDraft(),
  });
  // v1 Part 09 §Launch checklist. The user MUST affirm authorization before
  // Start review enables. Default off; a client-side gate only, but the
  // server also stamps `authorized_at` on the create as an audit trail.
  const [authorizationConfirmed, setAuthorizationConfirmed] = useState(false);
  const [steps, setSteps] = useState<StepDraft[]>([]);
  const paths = splitPaths(search.paths);

  // The preview is a query, not a mount-fired mutation: it self-settles and
  // dedupes, so no StrictMode double-run or orphaned-observer spinner.
  const previewQ = useSecurityPreview(
    {
      repo: search.repo,
      preset: search.preset,
      ...(search.ref ? { ref: search.ref } : {}),
      ...(paths.length > 0 ? { paths } : {}),
      ...(search.includeReport !== undefined ? { includeReport: search.includeReport } : {}),
    },
    search.repo !== "",
  );

  // Seed the editors from the preview once it arrives. A ref guards the seed so
  // a later re-render or refetch never clobbers the user's in-progress edits.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !previewQ.data) return;
    seeded.current = true;
    const seededScope = previewQ.data.config.authorizedScope;
    setConfig({
      focus: previewQ.data.config.focus ?? "",
      invariants: previewQ.data.config.invariants,
      categories: previewQ.data.config.categories,
      scope: {
        hosts: seededScope?.hosts ?? [],
        cidrs: seededScope?.cidrs ?? [],
        loginUrl: seededScope?.loginUrl ?? "",
        signupUrl: seededScope?.signupUrl ?? "",
        rateLimitRps: seededScope?.rateLimitRps !== undefined ? String(seededScope.rateLimitRps) : "",
      },
    });
    setSteps(previewQ.data.planCells.map(wireToDraft));
  }, [previewQ.data]);

  // True when the current plan carries any live persona. Drives the scope
  // section's REQUIRED asterisk and gates the "Start review" button.
  const hasLivePersona = planHasLivePersona(steps);
  const scopeHosts = normalizeScopeHostsForSubmit(config.scope);
  const scopeError = hasLivePersona && scopeHosts.length === 0
    ? "Add at least one authorized host on the Focus step; the plan includes a live persona."
    : null;
  const planError = draftError(steps);
  const [step, setStep] = useState<WizardStep>("focus");
  const stepIndex = WIZARD_STEPS.findIndex((s) => s.id === step);
  const loaded = previewQ.isSuccess;

  function next() {
    if (stepIndex < WIZARD_STEPS.length - 1) setStep(WIZARD_STEPS[stepIndex + 1].id);
  }
  function back() {
    if (stepIndex > 0) setStep(WIZARD_STEPS[stepIndex - 1].id);
  }

  function startReview() {
    if (
      create.isPending ||
      planError !== null ||
      scopeError !== null ||
      !authorizationConfirmed ||
      search.repo === ""
    ) {
      return;
    }
    const securityConfig: CreateSessionRequest["securityConfig"] = {
      focus: config.focus.trim() === "" ? null : config.focus.trim(),
      invariants: config.invariants.map((v) => v.trim()).filter((v) => v !== ""),
      categories: config.categories,
    };
    // The scope override rides only when the user set a non-empty host list.
    // A source-only plan with no scope authored omits the field so the seed
    // (or the repo's .valet/security.yml) still wins. Non-live plans with a
    // manually authored scope still ship it so a future live-persona add
    // does not lose the user's intent.
    const wireScope = scopeDraftToWire(config.scope);
    if (wireScope !== null) {
      securityConfig.scope = wireScope;
    }
    const body: CreateSessionRequest = {
      // Host working directory the api creates for the clone (docker bind-mount
      // source in dev), NOT the in-sandbox `/workspace` mount.
      workspace: workspaceForRepo(search.repo),
      kind: "security",
      model,
      preset: search.preset,
      repo: {
        host: "github",
        fullName: search.repo,
        cloneUrl: search.cloneUrl,
        ...(search.ref ? { ref: search.ref } : {}),
        auth: "auto",
      },
      securityConfig,
      planCells: draftToInput(steps),
    };
    if (paths.length > 0) body.paths = paths;
    if (search.teamId !== undefined) body.teamId = search.teamId;
    // Thread the hub's "Include a written report" choice through create. When
    // planCells is present (always, on the setup page), the server treats the
    // edited plan as authoritative and ignores includeReport — but shipping it
    // keeps the audit trail consistent.
    if (search.includeReport !== undefined) body.includeReport = search.includeReport;
    create.mutate(body, {
      onSuccess: (created) =>
        void navigate({ to: "/sessions/$sessionId", params: { sessionId: created.id } }),
    });
  }

  if (search.repo === "") {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <p className="text-sm text-danger-600">
          No repository selected. Go back to the hub and pick a repository.
        </p>
        <Button className="mt-3" variant="secondary" onClick={() => void navigate({ to: "/security" })}>
          Back to reviews
        </Button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Fixed header + stepper. */}
      <div className="shrink-0 border-b border-line px-6 py-4">
        <h1 className="text-lg font-semibold tracking-tight text-ink font-display">
          Configure review
        </h1>
        <p className="mt-1 text-xs text-muted">
          <span className="font-mono text-ink">{search.repo}</span>
          {search.ref ? <span className="font-mono"> @ {search.ref}</span> : null} ·{" "}
          {previewQ.data?.config.hasRepoConfig
            ? "configured by .valet/security.yml"
            : `preset ${search.preset}`}
        </p>
        <StepIndicator current={step} onJump={loaded ? setStep : undefined} className="mt-4" />
      </div>

      {/* Scrolling body — one step at a time, so the page never grows unbounded. */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl p-6">
          {previewQ.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted" data-testid="preview-loading">
              <Spinner size={14} /> Loading the seeded config and plan…
            </div>
          ) : previewQ.isError ? (
            <div
              className="rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-xs text-danger-600"
              data-testid="preview-error"
            >
              Could not load the review preview: {previewQ.error?.message ?? "unknown error"}
            </div>
          ) : (
            <>
              {step === "focus" && (
                <div className="space-y-6">
                  <div className="grid gap-1.5">
                    <Label htmlFor="new-model">Model</Label>
                    <select
                      id="new-model"
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      className="h-9 w-full rounded-md border border-line bg-paper px-2 text-xs text-ink"
                    >
                      {!SECURITY_MODELS.some((m) => m.id === model) && (
                        <option value={model}>{model}</option>
                      )}
                      {SECURITY_MODELS.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                          {m.note ? ` · ${m.note}` : ""}
                        </option>
                      ))}
                    </select>
                    <p className="text-[11px] text-muted">Drives the review and every sub-agent.</p>
                  </div>
                  <ConfigForm value={config} onChange={setConfig} requireLiveScope={hasLivePersona} />
                </div>
              )}

              {step === "plan" && <PlanStepsEditor value={steps} onChange={setSteps} />}

              {step === "review" && (
                <ReviewStep
                  repo={search.repo}
                  refName={search.ref}
                  model={model}
                  preset={search.preset}
                  hasRepoConfig={previewQ.data?.config.hasRepoConfig ?? false}
                  config={config}
                  steps={steps}
                  hasLivePersona={hasLivePersona}
                  authorizationConfirmed={authorizationConfirmed}
                  onAuthorizationChange={setAuthorizationConfirmed}
                />
              )}

              {create.isError && step === "review" && (
                <div
                  className="mt-4 rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-xs text-danger-600"
                  data-testid="create-error"
                >
                  {create.error.message}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Fixed footer — Back / Next, or Start on the last step. */}
      {loaded && (
        <div className="shrink-0 flex items-center justify-between gap-3 border-t border-line px-6 py-3">
          <Button
            variant="secondary"
            onClick={() => (stepIndex === 0 ? void navigate({ to: "/security" }) : back())}
          >
            {stepIndex === 0 ? "Cancel" : "Back"}
          </Button>
          <div className="flex items-center gap-3">
            {step === "plan" && planError && (
              <span className="text-[11px] text-danger-600">{planError}</span>
            )}
            {step === "review" && scopeError && (
              <span className="text-[11px] text-danger-600" data-testid="scope-error">
                {scopeError}
              </span>
            )}
            {step === "review" && !authorizationConfirmed && (
              <span className="text-[11px] text-danger-600" data-testid="authorization-error">
                Confirm authorization on the checklist to enable Start.
              </span>
            )}
            {step !== "review" ? (
              <Button onClick={next} disabled={step === "plan" && planError !== null}>
                Next: {WIZARD_STEPS[stepIndex + 1].label}
              </Button>
            ) : (
              <Button
                onClick={startReview}
                disabled={
                  create.isPending ||
                  planError !== null ||
                  scopeError !== null ||
                  !authorizationConfirmed
                }
              >
                {create.isPending ? "Starting…" : "Start review"}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The three-dot progress header. When `onJump` is set the steps are clickable —
 * there is no hard dependency between them, so a user can jump around. */
function StepIndicator({
  current,
  onJump,
  className,
}: {
  current: WizardStep;
  onJump?: (step: WizardStep) => void;
  className?: string;
}) {
  const currentIndex = WIZARD_STEPS.findIndex((s) => s.id === current);
  return (
    <nav aria-label="Configure review steps" className={cn("flex items-center", className)}>
      {WIZARD_STEPS.map((s, i) => {
        const active = i === currentIndex;
        const done = i < currentIndex;
        const inner = (
          <>
            <span
              className={cn(
                "grid h-5 w-5 place-items-center rounded-full text-[11px] font-medium",
                active
                  ? "bg-moss text-paper"
                  : done
                    ? "bg-moss-wash text-moss"
                    : "border border-line text-muted",
              )}
            >
              {done ? <Check className="h-3 w-3" aria-hidden /> : i + 1}
            </span>
            <span className={cn("text-xs", active ? "font-medium text-ink" : "text-muted")}>
              {s.label}
            </span>
          </>
        );
        return (
          <Fragment key={s.id}>
            {i > 0 && <span className="mx-2 h-px w-8 bg-line" aria-hidden />}
            {onJump ? (
              <button
                type="button"
                onClick={() => onJump(s.id)}
                aria-current={active ? "step" : undefined}
                className="flex items-center gap-1.5 rounded"
              >
                {inner}
              </button>
            ) : (
              <span className="flex items-center gap-1.5" aria-current={active ? "step" : undefined}>
                {inner}
              </span>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}

/** The final review: a read-only summary of the config and plan, then Start. */
function ReviewStep({
  repo,
  refName,
  model,
  preset,
  hasRepoConfig,
  config,
  steps,
  hasLivePersona,
  authorizationConfirmed,
  onAuthorizationChange,
}: {
  repo: string;
  refName?: string;
  model: string;
  preset: string;
  hasRepoConfig: boolean;
  config: ConfigDraft;
  steps: StepDraft[];
  hasLivePersona: boolean;
  authorizationConfirmed: boolean;
  onAuthorizationChange: (next: boolean) => void;
}) {
  const invariants = config.invariants.map((v) => v.trim()).filter((v) => v !== "");
  const none = <span className="text-muted">None</span>;
  const scopeHosts = config.scope.hosts.filter((h) => h.trim() !== "");
  const scopeMissing = hasLivePersona && scopeHosts.length === 0;
  const loginMissing = hasLivePersona && config.scope.loginUrl.trim() === "";
  // Which live personas surface which kinds of need (v1 Part 09 §Launch
  // checklist §Credential expectations). Informational: the runner may still
  // ask mid-run; the goal is to reduce surprise.
  const liveKinds = new Set<string>();
  const stepPersonas = new Set(steps.map((s) => s.persona));
  if (stepPersonas.has("dast")) liveKinds.add("dast");
  if (stepPersonas.has("fuzz")) liveKinds.add("fuzz");
  if (stepPersonas.has("exploit")) liveKinds.add("exploit");
  return (
    <div className="space-y-5">
      <div className="rounded-md border border-line bg-paper p-3 text-xs text-ink" data-testid="launch-checklist-intro">
        <p>
          Confirm the scope, credentials, and personas below. Live personas run
          against real hosts; a missing input becomes a mid-run pause where the
          engagement asks you for it.
        </p>
      </div>
      <dl className="divide-y divide-line rounded-md border border-line text-xs">
        <SummaryRow label="Repository">
          <span className="font-mono">
            {repo}
            {refName ? ` @ ${refName}` : ""}
          </span>
        </SummaryRow>
        <SummaryRow label="Model">{modelLabel(model)}</SummaryRow>
        <SummaryRow label="Method">
          {hasRepoConfig ? <span className="font-mono">.valet/security.yml</span> : `Preset · ${preset}`}
        </SummaryRow>
        <SummaryRow label="Focus">{config.focus.trim() || none}</SummaryRow>
        <SummaryRow label="Invariants">
          {invariants.length > 0 ? `${invariants.length} asserted` : none}
        </SummaryRow>
        <SummaryRow label="Categories">
          {config.categories.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {config.categories.map((id) => (
                <span key={id} className="rounded bg-ink-wash px-1.5 py-0.5 text-[10px] text-ink">
                  {categoryLabel(id)}
                </span>
              ))}
            </div>
          ) : (
            none
          )}
        </SummaryRow>
        <SummaryRow label="Scope">
          {scopeHosts.length > 0 ? (
            <div className="flex flex-wrap gap-1" data-testid="review-scope">
              {scopeHosts.map((host, i) => (
                <span
                  key={`${host}-${i}`}
                  className="rounded bg-ink-wash px-1.5 py-0.5 font-mono text-[10px] text-ink"
                >
                  {host}
                </span>
              ))}
            </div>
          ) : (
            none
          )}
        </SummaryRow>
        {config.scope.loginUrl.trim() !== "" && (
          <SummaryRow label="Login URL">
            <span className="font-mono">{config.scope.loginUrl.trim()}</span>
          </SummaryRow>
        )}
      </dl>

      {/* Live-testing warnings (v1 Part 09 §Launch checklist). Missing scope is
          a HARD block (Start disabled); missing login URL is a soft WARN that
          says the review will pause mid-run. */}
      {hasLivePersona && (
        <div className="rounded-md border border-warning-500/40 bg-warning-500/10 p-3 text-xs text-warning-700" data-testid="launch-live-warnings">
          <div className="font-semibold">Live testing checklist</div>
          <ul className="mt-1 list-disc pl-5 space-y-1">
            {scopeMissing ? (
              <li className="text-danger-600" data-testid="launch-warn-scope">
                No authorized host declared. Add at least one on the Focus step; Start is disabled until you do.
              </li>
            ) : (
              <li data-testid="launch-scope-ok">Authorized scope: {scopeHosts.length} host{scopeHosts.length === 1 ? "" : "s"}.</li>
            )}
            {loginMissing ? (
              <li data-testid="launch-warn-login">
                No login URL declared. When a live persona needs authentication, the review will pause and ask you.
              </li>
            ) : (
              !scopeMissing && <li data-testid="launch-login-ok">Login URL set.</li>
            )}
            {liveKinds.has("dast") && (
              <li data-testid="launch-cred-dast">
                DAST may ask for admin credentials to test <span className="font-mono">/admin/*</span>{" "}
                surface.
              </li>
            )}
            {liveKinds.has("fuzz") && (
              <li data-testid="launch-cred-fuzz">
                Fuzz may ask for test data (payment card, SSN) to fuzz payment / identity flows.
              </li>
            )}
            {liveKinds.has("exploit") && (
              <li data-testid="launch-cred-exploit">
                Exploit chains findings to a non-destructive PoC; READ then RESTORE. It may ask for a bounded blast radius.
              </li>
            )}
          </ul>
        </div>
      )}

      <div>
        <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
          Plan · {steps.length} steps
        </div>
        <ol className="divide-y divide-line rounded-md border border-line text-xs">
          {steps.map((s, i) => (
            <li key={s.key} className="flex items-center gap-2 px-3 py-1.5">
              <span className="shrink-0 tabular-nums text-muted">{i + 1}</span>
              {isPersonaDeterministic(s.persona) && (
                <span
                  className="shrink-0 rounded bg-moss-500/15 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-moss-600"
                  title="Deterministic persona"
                  aria-label="Deterministic persona"
                >
                  D
                </span>
              )}
              <span className="min-w-0 font-mono text-ink">{planLabel(s)}</span>
            </li>
          ))}
        </ol>
      </div>

      {/* Authorization affirmation (INV-11). Required to enable Start. */}
      <label
        className={cn(
          "flex items-start gap-2 rounded-md border p-3 text-xs",
          authorizationConfirmed
            ? "border-line bg-paper"
            : "border-danger-500/40 bg-danger-500/5 text-danger-700",
        )}
      >
        <input
          type="checkbox"
          checked={authorizationConfirmed}
          onChange={(e) => onAuthorizationChange(e.target.checked)}
          className="mt-0.5"
          data-testid="launch-authorization"
          aria-label="Confirm authorization"
        />
        <span>
          {hasLivePersona
            ? "I confirm I have authorization to test the hosts listed above."
            : "I confirm I have authorization to scan this repository."}
        </span>
      </label>
    </div>
  );
}

function SummaryRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex px-3 py-2">
      <dt className="w-28 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 text-ink">{children}</dd>
    </div>
  );
}
