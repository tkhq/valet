import { useState } from "react";
import type { SecurityEngagementWire, SecurityFindingWire } from "@valet/api/wire";
import { apiErrorText, useFileDigest, useFileIssue } from "~/api/security";
import { usePlugins } from "~/api/integrations";
import { useRepos } from "~/api/repos";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  Label,
} from "~/components/primitives";
import { ServiceIcon } from "~/components/service-icon";
import { cn } from "~/lib/cn";

/**
 * File-issue dialog (valet-security design §Filing issues). Two modes:
 * single finding, or a digest issue from the current filter's findings.
 * Providers come from the connected integrations; a disconnected one stays
 * visible but disabled with its corrective action — the same copy the
 * route's `MissingIntegrationError` answers with.
 *
 * Linear: no team-listing client exists in the web app (the Linear plugin
 * is MCP-backed; its tools resolve at run time), so the team is a text
 * input for the team id/key, remembered per engagement in localStorage
 * (`sec-linear-team-<engagementId>`). Spec deviation recorded in the spec.
 */

export type FileIssueTarget =
  | { mode: "single"; finding: SecurityFindingWire }
  | { mode: "digest"; findingIds: string[] };

type Provider = "github" | "linear";

export function linearTeamStorageKey(engagementId: string): string {
  return `sec-linear-team-${engagementId}`;
}

function readStoredTeam(engagementId: string): string {
  try {
    return window.localStorage.getItem(linearTeamStorageKey(engagementId)) ?? "";
  } catch {
    return "";
  }
}

const CONNECT_COPY: Record<Provider, string> = {
  github: "Connect the GitHub integration in Settings.",
  linear: "Connect the Linear integration in Settings.",
};

export function FileIssueDialog({
  sessionId,
  engagement,
  target,
  onClose,
}: {
  sessionId: string;
  engagement: SecurityEngagementWire;
  /** Null keeps the dialog closed. */
  target: FileIssueTarget | null;
  onClose: () => void;
}) {
  // The inner component mounts only while open, so the integration reads
  // fire on first open, not with the panel. Keyed by the target identity:
  // a new target gets fresh state, never another finding's draft.
  if (target === null) return null;
  const targetKey = target.mode === "single" ? target.finding.id : "digest";
  return (
    <FileIssueDialogInner
      key={targetKey}
      sessionId={sessionId}
      engagement={engagement}
      target={target}
      onClose={onClose}
    />
  );
}

function FileIssueDialogInner({
  sessionId,
  engagement,
  target,
  onClose,
}: {
  sessionId: string;
  engagement: SecurityEngagementWire;
  target: FileIssueTarget;
  onClose: () => void;
}) {
  const plugins = usePlugins();
  const repos = useRepos();

  // GitHub filing rides the acting user's GitHub connection (App or OAuth):
  // the repos read reports it either way, and the credential service covers
  // manual tokens. Linear is credential-only.
  const services = plugins.data?.plugins.flatMap((p) => p.services) ?? [];
  const githubConnected =
    repos.data?.connected === true ||
    services.some((s) => s.service === "github" && s.connected);
  const linearConnected = services.some((s) => s.service === "linear" && s.connected);
  const connected: Record<Provider, boolean> = {
    github: githubConnected,
    linear: linearConnected,
  };

  const [provider, setProvider] = useState<Provider | null>(null);
  // Mount-time defaults are safe here: the outer component keys this one by
  // the target, so a new target always remounts with fresh state (the
  // mount-time-state rule's stable-key clause).
  const [repo, setRepo] = useState(engagement.repoFullName);
  const [teamId, setTeamId] = useState(() => readStoredTeam(engagement.id));
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; created: boolean } | null>(null);

  const fileIssue = useFileIssue(sessionId);
  const fileDigest = useFileDigest(sessionId);
  const pending = fileIssue.isPending || fileDigest.isPending;

  function rememberTeam(next: string) {
    setTeamId(next);
    try {
      window.localStorage.setItem(linearTeamStorageKey(engagement.id), next);
    } catch {
      // Storage may be unavailable (private mode); the input still works.
    }
  }

  function submit() {
    if (provider === null) return;
    setError(null);
    const shared = {
      provider,
      ...(provider === "github" && repo.trim() !== "" ? { repo: repo.trim() } : {}),
      ...(provider === "linear" && teamId.trim() !== "" ? { teamId: teamId.trim() } : {}),
    };
    if (target.mode === "single") {
      fileIssue.mutate(
        { findingId: target.finding.id, ...shared },
        {
          onSuccess: (res) => setResult({ url: res.link.url, created: res.created }),
          onError: (err) => setError(apiErrorText(err)),
        },
      );
    } else {
      fileDigest.mutate(
        { findingIds: target.findingIds, ...shared },
        {
          onSuccess: (res) => setResult({ url: res.url, created: true }),
          onError: (err) => setError(apiErrorText(err)),
        },
      );
    }
  }

  const title = target.mode === "digest" ? "File digest issue" : "File issue";
  const description =
    target.mode === "digest"
      ? `One digest issue covering ${target.findingIds.length} filtered findings.`
      : target.finding.title;

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent title={title} description={description}>
        <div className="space-y-3 text-xs">
          <fieldset>
            <legend className="text-muted mb-1">Provider</legend>
            <div className="flex gap-1.5">
              {(["github", "linear"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  disabled={!connected[p]}
                  aria-pressed={provider === p}
                  onClick={() => setProvider(p)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-2 py-1.5",
                    provider === p
                      ? "border-accent-500 bg-accent-100/50 dark:bg-accent-900/40 text-ink"
                      : "border-line text-muted hover:text-ink",
                    !connected[p] && "opacity-50 cursor-not-allowed hover:text-muted",
                  )}
                >
                  <ServiceIcon slug={p} label={p} size="sm" />
                  {p === "github" ? "GitHub" : "Linear"}
                </button>
              ))}
            </div>
            {(["github", "linear"] as const).map((p) =>
              !connected[p] ? (
                <p key={p} className="mt-1 text-muted">
                  {p === "github" ? "GitHub" : "Linear"} is not connected. {CONNECT_COPY[p]}
                </p>
              ) : null,
            )}
          </fieldset>

          {provider === "github" && (
            <div className="space-y-1">
              <Label htmlFor="sec-issue-repo">Repository</Label>
              <Input
                id="sec-issue-repo"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="owner/name"
              />
            </div>
          )}
          {provider === "linear" && (
            <div className="space-y-1">
              <Label htmlFor="sec-issue-team">Linear team id</Label>
              <Input
                id="sec-issue-team"
                value={teamId}
                onChange={(e) => rememberTeam(e.target.value)}
                placeholder="e.g. TKAI"
              />
              <p className="text-muted">Remembered for this engagement.</p>
            </div>
          )}

          {error && <p className="text-danger-600">{error}</p>}
          {result && (
            <p>
              {result.created ? "Filed:" : "Already filed:"}{" "}
              <a
                href={result.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-600 dark:text-accent-100 hover:underline"
              >
                {result.url}
              </a>
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {result ? "Done" : "Cancel"}
          </Button>
          {!result && (
            <Button disabled={provider === null || pending} onClick={submit}>
              {pending ? "Filing…" : "File issue"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
