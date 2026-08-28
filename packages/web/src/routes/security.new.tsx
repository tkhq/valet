import { useEffect, useRef, useState } from "react";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import type { CreateSessionRequest } from "@valet/api/wire";
import { useCreateSession } from "~/api/queries";
import { useSecurityPreview } from "~/api/security";
import { workspaceForRepo } from "~/components/repo-combobox";
import { Button, Label, Spinner } from "~/components/primitives";
import { ConfigForm, type ConfigDraft } from "~/components/security/config-form";
import {
  PlanStepsEditor,
  draftError,
  draftToInput,
  wireToDraft,
  type StepDraft,
} from "~/components/security/plan-steps-editor";

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
      <div className="border-b border-line px-6 py-4">
        <h1 className="text-lg font-semibold tracking-tight text-ink font-display">
          Configure review
        </h1>
        <p className="mt-1 text-xs text-muted">
          <span className="font-mono text-ink">{search.repo}</span>
          {search.ref ? <span className="font-mono"> @ {search.ref}</span> : null} · preset{" "}
          {search.preset}
          {previewQ.data?.config.hasRepoConfig ? " · configured by .valet/security.yml" : ""}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-2xl space-y-6">
          <div className="grid gap-1">
            <Label htmlFor="new-model">Model</Label>
            <input
              id="new-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="h-8 w-64 rounded border border-line bg-paper px-2 text-xs text-ink"
              placeholder="claude-sonnet-4-6"
            />
            <p className="text-[11px] text-muted">
              The runner and its review personas use this model.
            </p>
          </div>

          {previewQ.isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted" data-testid="preview-loading">
              <Spinner size={14} /> Loading the seeded config and plan…
            </div>
          )}
          {previewQ.isError && (
            <div
              className="rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-xs text-danger-600"
              data-testid="preview-error"
            >
              Could not load the review preview: {previewQ.error?.message ?? "unknown error"}
            </div>
          )}

          {previewQ.isSuccess && (
            <>
              <section className="rounded border border-line bg-paper p-4">
                <ConfigForm value={config} onChange={setConfig} />
              </section>
              <section className="rounded border border-line bg-paper p-4">
                <PlanStepsEditor value={steps} onChange={setSteps} />
              </section>

              {create.isError && (
                <div
                  className="rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-xs text-danger-600"
                  data-testid="create-error"
                >
                  {create.error.message}
                </div>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => void navigate({ to: "/security" })}>
                  Cancel
                </Button>
                <Button
                  onClick={startReview}
                  disabled={create.isPending || planError !== null}
                >
                  {create.isPending ? "Starting…" : "Start review"}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
