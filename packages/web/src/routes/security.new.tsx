import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { Check } from "lucide-react";
import type { CreateSessionRequest } from "@valet/api/wire";
import { useCreateSession } from "~/api/queries";
import { useSecurityPreview } from "~/api/security";
import { workspaceForRepo } from "~/components/repo-combobox";
import { Button, Label, Spinner } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { ConfigForm, categoryLabel, type ConfigDraft } from "~/components/security/config-form";
import {
  PlanStepsEditor,
  draftError,
  draftToInput,
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
  { id: "review", label: "Review" },
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
}

function readSearch(raw: Record<string, unknown>): SecurityNewSearch {
  const text = (key: string): string | undefined =>
    typeof raw[key] === "string" && raw[key] !== "" ? (raw[key] as string) : undefined;
  return {
    repo: text("repo") ?? "",
    cloneUrl: text("cloneUrl") ?? "",
    preset: text("preset") ?? "code-review",
    model: text("model") ?? "",
    ...(text("ref") ? { ref: text("ref") } : {}),
    ...(text("paths") ? { paths: text("paths") } : {}),
    ...(text("teamId") ? { teamId: text("teamId") } : {}),
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
  const [config, setConfig] = useState<ConfigDraft>({ focus: "", invariants: [], categories: [] });
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
    },
    search.repo !== "",
  );

  // Seed the editors from the preview once it arrives. A ref guards the seed so
  // a later re-render or refetch never clobbers the user's in-progress edits.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !previewQ.data) return;
    seeded.current = true;
    setConfig({
      focus: previewQ.data.config.focus ?? "",
      invariants: previewQ.data.config.invariants,
      categories: previewQ.data.config.categories,
    });
    setSteps(previewQ.data.planCells.map(wireToDraft));
  }, [previewQ.data]);

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
    if (create.isPending || planError !== null || search.repo === "") return;
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
      securityConfig: {
        focus: config.focus.trim() === "" ? null : config.focus.trim(),
        invariants: config.invariants.map((v) => v.trim()).filter((v) => v !== ""),
        categories: config.categories,
      },
      planCells: draftToInput(steps),
    };
    if (paths.length > 0) body.paths = paths;
    if (search.teamId !== undefined) body.teamId = search.teamId;
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
                  <ConfigForm value={config} onChange={setConfig} />
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
            {step !== "review" ? (
              <Button onClick={next} disabled={step === "plan" && planError !== null}>
                Next: {WIZARD_STEPS[stepIndex + 1].label}
              </Button>
            ) : (
              <Button onClick={startReview} disabled={create.isPending || planError !== null}>
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
}: {
  repo: string;
  refName?: string;
  model: string;
  preset: string;
  hasRepoConfig: boolean;
  config: ConfigDraft;
  steps: StepDraft[];
}) {
  const invariants = config.invariants.map((v) => v.trim()).filter((v) => v !== "");
  const none = <span className="text-muted">None</span>;
  return (
    <div className="space-y-5">
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
      </dl>

      <div>
        <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
          Plan · {steps.length} steps
        </div>
        <ol className="divide-y divide-line rounded-md border border-line text-xs">
          {steps.map((s, i) => (
            <li key={s.key} className="flex gap-2 px-3 py-1.5">
              <span className="shrink-0 tabular-nums text-muted">{i + 1}</span>
              <span className="min-w-0 font-mono text-ink">{planLabel(s)}</span>
            </li>
          ))}
        </ol>
      </div>
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
