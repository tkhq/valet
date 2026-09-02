import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { SecurityEngagementWire, SessionSummary } from "@valet/api/wire";
import { useEngagement, useRescanReview, useSecurityReviews } from "~/api/security";
import { useRepos } from "~/api/repos";
import { Badge, Button, Input, Label, Spinner } from "~/components/primitives";
import { cn } from "~/lib/cn";
import type { SecurityNewSearch } from "./security.new";
import {
  RepoCombobox,
  workspaceForRepo,
  type RepoOption,
} from "~/components/repo-combobox";
import { CreateScopeLine, WorkspaceClause } from "~/components/workspace-clause";
import { useListOwner } from "~/lib/use-list-owner";
import { useWorkspaceScope } from "~/lib/workspace-scope";

/**
 * `/security` — the security review hub (valet-security design, §Web
 * Surfaces). Top: a "New review" card — repo picker (the same combobox the
 * new-session dialog uses), the sweep preset, an optional path scope, and the
 * model. Configure navigates to `/security/new`, where the user reviews the
 * seeded config + plan, edits them, then starts the review. Below: past
 * engagements from `GET /api/sessions?kind=security`, each row badged with
 * its engagement status from `GET /api/sessions/:id/security`.
 */
export const Route = createFileRoute("/security/")({
  component: SecurityIndexPage,
});

export function SecurityIndexPage() {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="border-b border-line px-6 py-4">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold tracking-tight text-ink font-display">
            Security reviews
          </h1>
          <WorkspaceClause />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-4xl space-y-8">
          <NewReviewCard />
          <ReviewList />
        </div>
      </div>
    </div>
  );
}

/** The selection the Start button submits: the picked repo plus the branch
 * the review starts from (the server pins the SHA at `sec_start`). */
interface SelectedRepo {
  fullName: string;
  cloneUrl: string;
  ref: string;
}

/** The hub always sends a model. This is the capable default the server also
 * falls to for a modelless security create — the picker defaults to it, so the
 * two agree. */
const SECURITY_DEFAULT_MODEL = "anthropic/claude-sonnet-5";

/** The sweep presets the hub offers. Mirrored from `SECURITY_PRESETS` in
 * `@valet/plugin-security`: that package's barrel pulls node builtins (fs/url
 * through the playbooks module), so the web cannot import it. The server-side
 * `isKnownPreset` check is the real gate — this list only populates the
 * picker. Keep the two in sync. */
interface PresetChoice {
  id: string;
  label: string;
  blurb: string;
  /** The review's logical passes. The setup page shows the exact step count
   * after triad review expands each sweep into plan → work → verify. */
  phases: string[];
}

/** The phase labels above that map to a deterministic persona (sast / dast /
 * fuzz / pivot-coordinator per plugin-security's DETERMINISTIC_PERSONA_IDS).
 * A pill for one of these labels renders a bold monospace "D" prefix to
 * signal reproducible output at a glance in the method card. */
const DETERMINISTIC_PHASE_LABELS: ReadonlySet<string> = new Set([
  "SAST",
  "DAST",
  "Fuzz",
  "Pivot coordinator",
]);

const SECURITY_PRESETS: readonly PresetChoice[] = [
  {
    id: "code-review",
    label: "Full code review",
    blurb: "The deep default. Every sweep is double-checked.",
    phases: ["Recon", "Access control", "Injection", "Secrets & config", "Verify"],
  },
  {
    id: "access-injection",
    label: "Access & injection",
    blurb: "Authorization and injection, nothing else.",
    phases: ["Recon", "Access control", "Injection", "Verify"],
  },
  {
    id: "secrets-config",
    label: "Secrets & config",
    blurb: "Fast, scanner-led secrets and config pass.",
    phases: ["Recon", "Secrets & config", "Verify"],
  },
  {
    id: "code-audit",
    label: "Code audit",
    blurb: "Threat model, code review, SAST, and attack tree analysis. Source-only, no active testing.",
    phases: ["Recon", "Threat model", "Code review", "SAST", "Access", "Injection", "Attack tree", "Verify"],
  },
  {
    id: "live-pentest",
    label: "Live pentest",
    blurb:
      "DAST + fuzz + exploit against an authorized scope. Set the scope on the next step.",
    phases: ["Recon", "Threat model", "DAST", "Fuzz", "Exploit", "Verify"],
  },
  {
    id: "code-audit-plus-live",
    label: "Code audit + live confirmation",
    blurb:
      "Every persona. Code audit plus live DAST, fuzz, exploit, and pivot coordination. Set the scope on the next step.",
    phases: [
      "Recon",
      "Threat model",
      "Code review",
      "SAST",
      "Access",
      "Injection",
      "DAST",
      "Fuzz",
      "Exploit",
      "Pivot coordinator",
      "Attack tree",
      "Verify",
    ],
  },
];

/** Security runs drive a tool loop over many turns, so the picker offers the
 * current-generation Claude 5 models only — the tiers that hold up across a
 * long agentic review — instead of the whole provider catalog. Sonnet is the
 * recommended balance; Opus goes deeper on hard reasoning. */
const SECURITY_MODELS: readonly { id: string; label: string; note: string }[] = [
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", note: "Recommended" },
  { id: "anthropic/claude-opus-5", label: "Claude Opus 5", note: "Deepest" },
];

/** Split a "Scope to paths" input into include globs. Commas and whitespace
 * both separate; empty segments drop out. */
function splitPaths(input: string): string[] {
  return input
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
}

function NewReviewCard() {
  const navigate = useNavigate();
  const reposQ = useRepos();
  // The nav's switcher answers "whose review is this" — same pass-through
  // the new-session dialog uses (`CreateScopeLine` states it).
  const scope = useWorkspaceScope();
  const [repo, setRepo] = useState<SelectedRepo | null>(null);
  // The hub always submits a model; sonnet-4-6 is the capable default. This is
  // a fixed default, not derived from a prop, so no mount-time-state sync is
  // needed — the value only changes when the user picks another model.
  const [model, setModel] = useState(SECURITY_DEFAULT_MODEL);
  // Preset and path scope are fixed local defaults, not derived from a prop,
  // so no mount-time-state sync is needed — each only changes on user input.
  const [preset, setPreset] = useState(SECURITY_PRESETS[0].id);
  const [pathsInput, setPathsInput] = useState("");
  // "Include a written report at the end" checkbox (Part 08 §Setup Step 1).
  // The preset gates the default — the wide presets (`code-review`,
  // `code-audit`, `live-pentest`, `code-audit-plus-live`) default the box on;
  // the narrow ones (`secrets-config`, `access-injection`) default off. Each
  // preset selection resets the choice; a manual toggle sticks until the
  // preset changes.
  const [includeReport, setIncludeReport] = useState<boolean>(true);

  const repos = reposQ.data?.repos ?? [];
  const connected = reposQ.data?.connected ?? false;
  const installed = reposQ.data?.installed ?? false;
  const showConnectHint = !connected && !installed;

  function pickRepo(option: RepoOption) {
    setRepo({
      fullName: option.fullName,
      cloneUrl: option.cloneUrl ?? option.url,
      ref: option.defaultBranch,
    });
  }

  // A public repo the connected GitHub app cannot see — the picker offers it
  // inline once the typed value parses. The binding carries an empty ref; the
  // server resolves the default branch HEAD and clones anonymously (a public
  // repo needs no token).
  function addPublicRepo(parsed: { fullName: string; cloneUrl: string }) {
    setRepo({ fullName: parsed.fullName, cloneUrl: parsed.cloneUrl, ref: "" });
  }

  function configure() {
    if (!repo) return;
    // Navigate to the setup page with the selection. The setup page fetches the
    // preview, lets the user edit the config + plan, then creates the review.
    const paths = splitPaths(pathsInput);
    const search: SecurityNewSearch = {
      repo: repo.fullName,
      cloneUrl: repo.cloneUrl,
      preset,
      model,
      includeReport,
      ...(repo.ref.trim() ? { ref: repo.ref.trim() } : {}),
      ...(paths.length > 0 ? { paths: paths.join(",") } : {}),
      ...(scope.teamId !== undefined ? { teamId: scope.teamId } : {}),
    };
    void navigate({ to: "/security/new", search });
  }

  return (
    <section className="rounded-lg border border-line bg-paper p-5 space-y-5">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Start a review</h2>
          <p className="mt-0.5 text-xs text-muted">
            Scan a repository for security issues and triage the findings.
          </p>
        </div>
        <CreateScopeLine what="review" />
      </div>

      {/* 1 · Repository — the one required input, so it leads. */}
      <div className="grid gap-1.5">
        <Label>Repository</Label>
        {repo ? (
          <div className="rounded-md border border-line bg-ink-wash/40 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate font-mono text-sm text-ink">{repo.fullName}</span>
              <button
                type="button"
                aria-label={`Remove ${repo.fullName}`}
                onClick={() => setRepo(null)}
                className="shrink-0 text-xs text-muted hover:text-danger-500"
              >
                Remove
              </button>
            </div>
            <div className="mt-2.5 flex items-center gap-2">
              <Label htmlFor="review-ref" className="shrink-0 text-[11px] uppercase tracking-wide text-muted">
                Branch
              </Label>
              <Input
                id="review-ref"
                aria-label={`Branch for ${repo.fullName}`}
                value={repo.ref}
                placeholder="default branch"
                onChange={(e) => setRepo({ ...repo, ref: e.target.value })}
                className="h-8 w-52 text-xs"
              />
              <span className="text-[11px] text-muted">Leave blank to scan the default branch.</span>
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            <RepoCombobox
              repos={repos}
              label="Search repositories"
              onSelect={pickRepo}
              onSelectPublic={addPublicRepo}
            />
            <p className="text-[11px] text-muted">
              {showConnectHint ? (
                <>
                  Type any public repo as owner/repo or a GitHub URL.{" "}
                  <a href="/settings/connected-accounts" className="text-moss underline">
                    Connect GitHub
                  </a>{" "}
                  to list your organization&apos;s repositories.
                </>
              ) : (
                "Not in your organization? Type any public repo as owner/repo or a GitHub URL."
              )}
            </p>
          </div>
        )}
      </div>

      {/* 2 · Method — selectable preset cards, each showing its passes. */}
      <div className="grid gap-1.5">
        <div className="flex items-baseline justify-between">
          <Label>Method</Label>
          <span className="text-[11px] text-muted">
            A <span className="font-mono">.valet/security.yml</span> in the repo overrides this.
          </span>
        </div>
        <div role="radiogroup" aria-label="Review method" className="grid grid-cols-2 gap-2">
          {SECURITY_PRESETS.map((p) => {
            const selected = p.id === preset;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={p.label}
                onClick={() => setPreset(p.id)}
                className={cn(
                  "flex flex-col gap-2 rounded-md border p-3 text-left transition-colors",
                  selected
                    ? "border-moss bg-moss-wash ring-1 ring-moss"
                    : "border-line hover:border-ink-wash-strong",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-medium text-ink">{p.label}</span>
                  <span
                    className={cn(
                      "grid h-4 w-4 shrink-0 place-items-center rounded-full border",
                      selected ? "border-moss bg-moss text-paper" : "border-line",
                    )}
                    aria-hidden
                  >
                    {selected && (
                      <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none">
                        <path d="M2.5 6.5l2.5 2.5 4.5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                </div>
                <span className="text-[11px] leading-snug text-muted">{p.blurb}</span>
                <div className="flex flex-wrap gap-1">
                  {p.phases.map((ph, i) => {
                    const det = DETERMINISTIC_PHASE_LABELS.has(ph);
                    return (
                      <span
                        key={ph}
                        className="inline-flex items-center gap-1 rounded bg-ink-wash px-1.5 py-0.5 text-[10px] text-muted"
                        title={det ? "Deterministic phase: scanner-driven or L0 decision" : undefined}
                      >
                        <span>{i + 1}.</span>
                        <span>{ph}</span>
                        {det && (
                          <span
                            className="font-mono font-bold text-danger-600"
                            aria-label="Deterministic phase"
                          >
                            D
                          </span>
                        )}
                      </span>
                    );
                  })}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 3 · Model + scope — secondary controls, side by side. */}
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="review-model">Model</Label>
          <select
            id="review-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="h-9 rounded-md border border-line bg-paper px-2 text-xs text-ink"
          >
            {SECURITY_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {m.note ? ` · ${m.note}` : ""}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-muted">Drives the review and every sub-agent.</p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="review-paths">Scope to paths</Label>
          <Input
            id="review-paths"
            value={pathsInput}
            onChange={(e) => setPathsInput(e.target.value)}
            placeholder="packages/api, src/auth"
            className="h-9 text-xs"
          />
          <p className="text-[11px] text-muted">Optional. Narrows the sweeps to these paths.</p>
        </div>
      </div>

      {/* Written-report checkbox (Part 08 §Setup Step 1 · Report is a user
          choice, not preset-baked). Default on for every preset; uncheck to
          skip the report cell. */}
      <div className="grid gap-1.5">
        <label className="flex items-center gap-2 text-xs text-ink">
          <input
            type="checkbox"
            checked={includeReport}
            onChange={(e) => setIncludeReport(e.target.checked)}
            data-testid="review-include-report"
            aria-label="Include a written report at the end"
          />
          Include a written report at the end
        </label>
        <p className="text-[11px] text-muted">
          Adds a `report` cell after `verify` that composes the audience-graded
          markdown and a JSON snapshot. Uncheck to skip.
        </p>
      </div>

      <div className="flex items-center justify-end gap-3 border-t border-line pt-4">
        {repo === null && (
          <span className="text-[11px] text-muted">Pick a repository to continue.</span>
        )}
        <Button onClick={configure} disabled={repo === null}>
          Configure review →
        </Button>
      </div>
    </section>
  );
}

function ReviewList() {
  // The nav's workspace switcher decides which workspace this list is FOR —
  // same rule as the workflows hub.
  const owner = useListOwner();
  const { data, isLoading, error } = useSecurityReviews(owner);
  const reviews = data?.sessions ?? [];

  return (
    <div className="space-y-2.5">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold text-ink">Reviews</h2>
        {reviews.length > 0 && (
          <span className="text-xs text-muted">{reviews.length}</span>
        )}
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Spinner size={14} /> Loading reviews…
        </div>
      ) : error ? (
        <div className="rounded-md border border-danger-500/30 bg-danger-wash px-3 py-2 text-sm text-danger-600">
          Could not load reviews. Reload the page to retry.
        </div>
      ) : reviews.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line px-4 py-10 text-center">
          <p className="text-sm text-ink">No reviews yet</p>
          <p className="mx-auto mt-1 max-w-xs text-xs text-muted">
            Start a review above. Findings, coverage, and a report appear here as it runs.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {reviews.map((session) => (
            <ReviewRow key={session.id} session={session} />
          ))}
        </ul>
      )}
    </div>
  );
}

const STATUS_META: Record<
  SecurityEngagementWire["status"],
  { label: string; dot: string; variant: "neutral" | "accent" | "success" | "danger" }
> = {
  planning: { label: "Planning", dot: "bg-muted", variant: "neutral" },
  running: { label: "Running", dot: "bg-moss", variant: "accent" },
  completed: { label: "Completed", dot: "bg-success-500", variant: "success" },
  failed: { label: "Failed", dot: "bg-danger-500", variant: "danger" },
  cancelled: { label: "Cancelled", dot: "bg-muted", variant: "neutral" },
};

/** A 40-hex SHA shows its first 7; a branch/tag name shows whole. */
function shortRef(ref: string): string {
  return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 7) : ref;
}

function ReviewRow({ session }: { session: SessionSummary }) {
  const navigate = useNavigate();
  // One extra read per row: the list endpoint carries the session, not the
  // engagement, and the status + progress belong to the engagement. The hub's
  // list is short and view-gated.
  const engagementQ = useEngagement(session.id);
  const engagement = engagementQ.data?.engagement;
  const cells = engagementQ.data?.cells ?? [];
  const costUsd = engagementQ.data?.cost?.costUsd ?? 0;
  const rescan = useRescanReview();

  const status = engagement?.status;
  const meta = status ? STATUS_META[status] : null;
  const done = cells.filter((c) => c.status === "completed").length;
  const total = cells.length;
  const terminal = status === "completed" || status === "failed";
  const repoName = engagement?.repoFullName ?? session.title ?? session.workspace;
  const ref = engagement?.repoRef ?? "";

  return (
    // `relative` anchors the stretched link: the whole row opens the session.
    <li className="group relative flex items-center gap-4 rounded-md border border-line bg-paper px-4 py-3 hover:border-ink-wash-strong">
      <span
        className={cn(
          "relative mt-1.5 h-2 w-2 shrink-0 rounded-full",
          meta?.dot ?? "bg-line",
        )}
        aria-hidden
      >
        {status === "running" && (
          <span className="absolute inset-0 animate-ping rounded-full bg-moss opacity-60" />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <Link
          to="/sessions/$sessionId"
          params={{ sessionId: session.id }}
          className="min-w-0 font-mono text-sm text-ink after:absolute after:inset-0 after:content-[''] group-hover:underline"
        >
          {repoName}
          {ref !== "" && <span className="text-muted"> @ {shortRef(ref)}</span>}
        </Link>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted">
          <span>{new Date(session.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
          {status === "running" && total > 0 && (
            <>
              <span aria-hidden>·</span>
              <span>
                {done}/{total} steps
              </span>
            </>
          )}
          {costUsd > 0 && (
            <>
              <span aria-hidden>·</span>
              <span className="font-mono">${costUsd < 0.01 ? costUsd.toFixed(4) : costUsd.toFixed(2)}</span>
            </>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {terminal && engagement && (
          // `relative z-10` lifts the button above the row's stretched link.
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="relative z-10 opacity-0 transition-opacity group-hover:opacity-100"
            disabled={rescan.isPending}
            onClick={() => {
              rescan.mutate(
                { rescanOf: session.id, workspace: workspaceForRepo(engagement.repoFullName) },
                {
                  onSuccess: (created) =>
                    void navigate({ to: "/sessions/$sessionId", params: { sessionId: created.id } }),
                },
              );
            }}
          >
            {rescan.isPending ? "Starting…" : "Re-scan"}
          </Button>
        )}
        {meta && (
          <Badge variant={meta.variant} className="shrink-0">
            {meta.label}
          </Badge>
        )}
      </div>
    </li>
  );
}
