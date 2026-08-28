import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type {
  CreateSessionRequest,
  SecurityEngagementWire,
  SessionSummary,
} from "@valet/api/wire";
import { useCreateSession } from "~/api/queries";
import { useEngagement, useSecurityReviews } from "~/api/security";
import { useModels } from "~/api/settings";
import { useRepos } from "~/api/repos";
import { curatedForCatalogId, MODEL_CATALOG } from "~/lib/models";
import { Badge, Button, Input, Label, Spinner, Textarea } from "~/components/primitives";
import { RepoCombobox, workspaceForRepo, type RepoOption } from "~/components/repo-combobox";
import { CreateScopeLine, WorkspaceClause } from "~/components/workspace-clause";
import { useListOwner } from "~/lib/use-list-owner";
import { useWorkspaceScope } from "~/lib/workspace-scope";

/**
 * `/security` — the security review hub (valet-security design, §Web
 * Surfaces). Top: a "New review" card — repo picker (the same combobox the
 * new-session dialog uses), the preset (v1 ships only Code review), an
 * optional focus prompt. Start POSTs `kind: "security"` with the repo
 * binding; the server seeds the engagement with the code-review preset in
 * the same transaction and this page navigates to the session. Below: past
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
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        <NewReviewCard />
        <ReviewList />
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
const SECURITY_DEFAULT_MODEL = "claude-sonnet-4-6";

/** One model option for the hub's picker: the id sent on the wire plus a short
 * label. */
interface ModelChoice {
  id: string;
  label: string;
}

function NewReviewCard() {
  const navigate = useNavigate();
  const create = useCreateSession();
  const reposQ = useRepos();
  // The nav's switcher answers "whose review is this" — same pass-through
  // the new-session dialog uses (`CreateScopeLine` states it).
  const scope = useWorkspaceScope();
  const modelsQ = useModels();
  const [repo, setRepo] = useState<SelectedRepo | null>(null);
  const [prompt, setPrompt] = useState("");
  // The hub always submits a model; sonnet-4-6 is the capable default. This is
  // a fixed default, not derived from a prop, so no mount-time-state sync is
  // needed — the value only changes when the user picks another model.
  const [model, setModel] = useState(SECURITY_DEFAULT_MODEL);

  // Model options: the org catalog when it loads (curated label when the id
  // maps to a known tier, else the catalog name), else the curated
  // `MODEL_CATALOG`. The default id is always present, so the select can show
  // it even before the catalog loads.
  const catalog = modelsQ.data?.models;
  const modelChoices: ModelChoice[] =
    catalog && catalog.length > 0
      ? catalog.map((m) => ({ id: m.id, label: curatedForCatalogId(m.id)?.label ?? m.name }))
      : MODEL_CATALOG.map((m) => ({ id: m.id, label: m.label }));
  const hasDefault = modelChoices.some((m) => m.id === model);

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

  async function start() {
    if (!repo || create.isPending) return;
    const body: CreateSessionRequest = {
      // Host working directory the api creates for the clone (docker
      // bind-mount source in dev), NOT the in-sandbox `/workspace` mount —
      // the hub has no editable path field, so it must send a real host path.
      workspace: workspaceForRepo(repo.fullName),
      kind: "security",
      model,
      repo: {
        host: "github",
        fullName: repo.fullName,
        cloneUrl: repo.cloneUrl,
        ref: repo.ref,
        auth: "auto",
      },
    };
    if (scope.teamId !== undefined) body.teamId = scope.teamId;
    const focus = prompt.trim();
    if (focus) body.initialPrompt = focus;
    try {
      const created = await create.mutateAsync(body);
      void navigate({ to: "/sessions/$sessionId", params: { sessionId: created.id } });
    } catch {
      // useMutation surfaces the error in `create.error`; the card stays put.
    }
  }

  return (
    <section className="rounded border border-line bg-paper p-4 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-ink">New review</h2>
        <p className="text-xs text-muted">
          The engagement runner scans one repository and reports findings for triage.
        </p>
      </div>
      <CreateScopeLine what="review" />

      <div className="grid gap-1">
        <Label>Repository</Label>
        {repo ? (
          <div className="flex items-center justify-between gap-2 rounded border border-line p-2.5">
            <span className="min-w-0 truncate text-sm font-medium text-ink">{repo.fullName}</span>
            <div className="flex shrink-0 items-center gap-2">
              <Label htmlFor="review-ref" className="text-xs text-muted">
                Branch
              </Label>
              <Input
                id="review-ref"
                aria-label={`Branch for ${repo.fullName}`}
                value={repo.ref}
                onChange={(e) => setRepo({ ...repo, ref: e.target.value })}
                className="h-8 w-36 text-xs"
              />
              <button
                type="button"
                aria-label={`Remove ${repo.fullName}`}
                onClick={() => setRepo(null)}
                className="text-xs text-muted hover:text-danger-500"
              >
                Remove
              </button>
            </div>
          </div>
        ) : showConnectHint ? (
          <p className="text-xs text-muted">
            Connect GitHub or install the App to pick a repository.{" "}
            <a href="/settings/connected-accounts" className="text-moss underline">
              Go to settings
            </a>
          </p>
        ) : (
          <RepoCombobox repos={repos} label="Search repositories" onSelect={pickRepo} />
        )}
      </div>

      <div className="grid gap-1">
        <Label htmlFor="review-preset">Preset</Label>
        {/* v1 ships one preset. The select is disabled, not hidden, so the
            choice this card will grow is visible where it will appear. The
            server seeds the code-review plan on create; there is no preset
            field on the wire yet. */}
        <select
          id="review-preset"
          disabled
          value="code-review"
          onChange={() => {}}
          className="h-8 w-48 rounded border border-line bg-paper px-2 text-xs text-ink disabled:opacity-70"
        >
          <option value="code-review">Code review</option>
        </select>
        <p className="text-xs text-muted">
          Five cells: recon, authz sweep, injection sweep, secrets and config, verify.
        </p>
      </div>

      <div className="grid gap-1">
        <Label htmlFor="review-model">Model</Label>
        {/* The runner and its personas run on this model. Sonnet 4.6 is the
            default — a capable model for review, not the haiku floor. */}
        <select
          id="review-model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="h-8 w-48 rounded border border-line bg-paper px-2 text-xs text-ink"
        >
          {!hasDefault && <option value={model}>{model}</option>}
          {modelChoices.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted">The runner and its review personas use this model.</p>
      </div>

      <div className="grid gap-1">
        <Label htmlFor="review-prompt">Prompt (optional)</Label>
        <Textarea
          id="review-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Focus areas, constraints…"
          rows={3}
        />
      </div>

      {create.error && (
        <div className="rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-xs text-danger-600">
          {create.error.message}
        </div>
      )}

      <div className="flex justify-end">
        <Button onClick={() => void start()} disabled={repo === null || create.isPending}>
          {create.isPending ? "Starting…" : "Start review"}
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

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Spinner size={14} /> Loading security reviews…
      </div>
    );
  }
  if (error) {
    return <div className="text-sm text-danger-500">Failed to load security reviews.</div>;
  }
  if (reviews.length === 0) {
    return (
      <p className="text-sm text-muted">
        No security reviews yet. Point one at a repository to start.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {reviews.map((session) => (
        <ReviewRow key={session.id} session={session} />
      ))}
    </ul>
  );
}

const STATUS_VARIANT: Record<
  SecurityEngagementWire["status"],
  "neutral" | "accent" | "success" | "danger"
> = {
  planning: "neutral",
  running: "accent",
  completed: "success",
  failed: "danger",
};

function ReviewRow({ session }: { session: SessionSummary }) {
  // One extra read per row: the list endpoint carries the session, not the
  // engagement, and the status badge belongs to the engagement. The hub's
  // list is short and view-gated; finding counts stay on M8's panel.
  const engagementQ = useEngagement(session.id);
  const engagement = engagementQ.data?.engagement;
  const title = session.title ?? engagement?.repoFullName ?? session.workspace;

  return (
    // `relative` anchors the stretched link below: the whole row opens the
    // session (the workflows hub row precedent).
    <li className="group relative flex items-center justify-between gap-3 rounded border border-line bg-paper px-4 py-3 hover:border-ink-wash-strong">
      <div className="flex min-w-0 items-center gap-2">
        <Link
          to="/sessions/$sessionId"
          params={{ sessionId: session.id }}
          className="min-w-0 truncate text-sm font-medium text-ink after:absolute after:inset-0 after:content-[''] group-hover:underline"
        >
          {title}
        </Link>
        {engagement && session.title != null && (
          <span className="shrink-0 truncate text-xs text-muted">{engagement.repoFullName}</span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="text-xs text-muted">
          {new Date(session.createdAt).toLocaleDateString()}
        </span>
        {engagement && (
          <Badge variant={STATUS_VARIANT[engagement.status]}>{engagement.status}</Badge>
        )}
      </div>
    </li>
  );
}
