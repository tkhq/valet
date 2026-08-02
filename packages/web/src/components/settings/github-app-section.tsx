import { useRef, useState } from "react";
import type { GithubAppInstallationSummary, PostGithubAppManifestResponse } from "@valet/api/wire";
import { Badge, Button, Input, Spinner, Switch } from "~/components/primitives";
import {
  useCreateGithubAppManifest,
  useDeleteGithubApp,
  useGithubApp,
  useRefreshGithubApp,
} from "~/api/settings";

/**
 * Organization · GitHub — the App-manifest setup flow (GitHub/repo
 * integration plan, Task 5/11), rendered inside `/settings/organization`'s
 * `OrgRouteGuard`. Two states: not-configured (a "Create GitHub App" button
 * that mints a manifest and hands the browser off to GitHub via a POSTed
 * form — GitHub's manifest flow only accepts a browser form submission, not
 * a fetch/XHR) and configured (app card + installations table + refresh +
 * webhook-mode badge + destructive removal).
 */
export function GithubAppSection() {
  const githubAppQ = useGithubApp();

  if (githubAppQ.isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted">
        <Spinner size={14} /> Loading…
      </div>
    );
  }
  if (githubAppQ.error) {
    return <div className="py-4 text-sm text-danger-500">Failed to load the GitHub App.</div>;
  }
  if (!githubAppQ.data) return null;

  return githubAppQ.data.configured ? (
    <ConfiguredCard data={githubAppQ.data} />
  ) : (
    <NotConfiguredCard webhookMode={githubAppQ.data.webhook.mode} />
  );
}

// GitHub App permissions the picker offers (V1 parity), with the levels
// GitHub actually supports per permission.
const AVAILABLE_PERMISSIONS: { key: string; label: string; levels: string[] }[] = [
  { key: "contents", label: "Repository contents", levels: ["read", "write"] },
  { key: "metadata", label: "Metadata", levels: ["read"] },
  { key: "pull_requests", label: "Pull requests", levels: ["read", "write"] },
  { key: "issues", label: "Issues", levels: ["read", "write"] },
  { key: "actions", label: "Actions", levels: ["read", "write"] },
  { key: "checks", label: "Checks", levels: ["read", "write"] },
  { key: "statuses", label: "Commit statuses", levels: ["read", "write"] },
  { key: "deployments", label: "Deployments", levels: ["read", "write"] },
  { key: "environments", label: "Environments", levels: ["read", "write"] },
  { key: "pages", label: "Pages", levels: ["read", "write"] },
  { key: "workflows", label: "Workflows", levels: ["write"] },
  { key: "members", label: "Organization members", levels: ["read"] },
  { key: "administration", label: "Administration", levels: ["read", "write"] },
];

const AVAILABLE_EVENTS = [
  "push", "pull_request", "issues", "issue_comment",
  "create", "delete", "release", "workflow_run",
  "check_run", "check_suite", "status",
];

// Mirror the server defaults so opening the picker shows what an untouched
// create would request.
const DEFAULT_PERMISSIONS: Record<string, string> = {
  contents: "write",
  metadata: "read",
  pull_requests: "write",
  issues: "write",
  actions: "write",
  checks: "read",
  statuses: "read",
};

const DEFAULT_EVENTS = ["push", "pull_request", "issue_comment"];

function NotConfiguredCard({ webhookMode }: { webhookMode: "public" | "manual" }) {
  const createManifest = useCreateGithubAppManifest();
  const [manifest, setManifest] = useState<PostGithubAppManifestResponse | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // Target: personal account by default; switch on to create the App
  // under a GitHub organization instead.
  const [underOrg, setUnderOrg] = useState(false);
  const [githubOrg, setGithubOrg] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [permissions, setPermissions] = useState<Record<string, string>>(DEFAULT_PERMISSIONS);
  const [events, setEvents] = useState<string[]>(DEFAULT_EVENTS);
  // Webhook delivery: only possible when the server has a public URL —
  // GitHub rejects manifests whose hook URL isn't publicly reachable,
  // so the switch is forced off and disabled in manual mode.
  const webhookPossible = webhookMode === "public";
  const [webhookOn, setWebhookOn] = useState(webhookPossible);

  const orgMissing = underOrg && githubOrg.trim().length === 0;

  async function create() {
    try {
      const res = await createManifest.mutateAsync({
        webhook: webhookPossible && webhookOn,
        ...(underOrg && githubOrg.trim() ? { target: `org:${githubOrg.trim()}` } : {}),
        ...(showAdvanced ? { permissions, events } : {}),
      });
      setManifest(res);
    } catch {
      // useMutation surfaces the error via `createManifest.error`.
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Create a GitHub App for this organization to let the assistant clone and push to your
        repos.
      </p>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm text-ink">
          <Switch checked={underOrg} onCheckedChange={setUnderOrg} aria-label="Create under a GitHub organization" />
          Create under a GitHub organization
        </label>
        {underOrg && (
          <div className="max-w-xs space-y-1 pl-11">
            <Input
              value={githubOrg}
              onChange={(e) => setGithubOrg(e.target.value)}
              placeholder="acme-corp"
              aria-label="GitHub organization"
            />
            <p className="text-xs text-muted">
              The GitHub organization the App is created and installed under. Off → your
              personal account.
            </p>
          </div>
        )}
      </div>

      <div className="space-y-1">
        <label className="flex items-center gap-2 text-sm text-ink">
          <Switch
            checked={webhookPossible && webhookOn}
            onCheckedChange={setWebhookOn}
            disabled={!webhookPossible}
            aria-label="Deliver webhook events"
          />
          Deliver webhook events
        </label>
        {!webhookPossible && (
          <p className="pl-11 text-xs text-muted">
            Needs a public URL GitHub can reach — set VALET_PUBLIC_URL (e.g. a tunnel) and
            reload. Without it the App is created with no webhook.
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={() => setShowAdvanced((v) => !v)}
        className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline"
      >
        {showAdvanced ? "Hide permissions" : "Configure permissions"}
      </button>

      {showAdvanced && (
        <div className="space-y-4 rounded-md border border-line bg-ink-wash p-4">
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">Permissions</p>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {AVAILABLE_PERMISSIONS.map((perm) => (
                <label key={perm.key} className="flex items-center gap-2 text-xs text-ink">
                  <select
                    value={permissions[perm.key] ?? ""}
                    aria-label={`${perm.label} permission`}
                    onChange={(e) => {
                      setPermissions((prev) => {
                        const next = { ...prev };
                        if (e.target.value) next[perm.key] = e.target.value;
                        else delete next[perm.key];
                        return next;
                      });
                    }}
                    className="rounded border border-line bg-paper px-1.5 py-0.5 text-xs"
                  >
                    <option value="">none</option>
                    {perm.levels.map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                  {perm.label}
                </label>
              ))}
            </div>
          </div>
          {webhookPossible && webhookOn && (
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">Webhook events</p>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {AVAILABLE_EVENTS.map((event) => (
                <label key={event} className="flex items-center gap-1.5 font-mono text-xs text-ink">
                  <input
                    type="checkbox"
                    checked={events.includes(event)}
                    onChange={(e) => {
                      setEvents((prev) =>
                        e.target.checked ? [...prev, event] : prev.filter((ev) => ev !== event),
                      );
                    }}
                  />
                  {event}
                </label>
              ))}
            </div>
          </div>
          )}
        </div>
      )}

      <Button type="button" onClick={() => void create()} disabled={createManifest.isPending || orgMissing}>
        {createManifest.isPending ? "Creating…" : "Create GitHub App"}
      </Button>
      {createManifest.error && (
        <p className="text-sm text-danger-500">{createManifest.error.message}</p>
      )}
      {manifest && (
        <div className="space-y-2 rounded-md border border-line bg-ink-wash p-4">
          <p className="text-xs text-muted">
            Ready — continue to GitHub to finish creating the app.
          </p>
          {/* GitHub's manifest-creation flow requires a real browser POST
              (not fetch/XHR): the form target is GitHub's own page, which
              redirects back to our `/setup` callback with a `code` GitHub
              mints, using the signed `state` we round-trip via the query
              string. */}
          <form
            ref={formRef}
            method="post"
            action={`${manifest.url}?state=${encodeURIComponent(manifest.state)}`}
            data-testid="github-manifest-form"
          >
            <input type="hidden" name="manifest" value={JSON.stringify(manifest.manifest)} />
          </form>
          <Button type="button" variant="primary" onClick={() => formRef.current?.submit()}>
            Continue to GitHub
          </Button>
        </div>
      )}
    </div>
  );
}

function ConfiguredCard({
  data,
}: {
  data: { app?: { appId: string; appSlug: string; htmlUrl: string; installUrl: string }; installations: GithubAppInstallationSummary[]; webhook: { mode: "public" | "manual" } };
}) {
  const refresh = useRefreshGithubApp();
  const deleteApp = useDeleteGithubApp();
  const app = data.app;

  return (
    <div className="space-y-6">
      <div className="space-y-3 rounded-md border border-line p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="text-sm font-medium text-ink">{app?.appSlug}</div>
            <div className="text-xs text-muted">App ID {app?.appId}</div>
            {app && (
              <a
                href={app.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-moss underline"
              >
                View on GitHub
              </a>
            )}
          </div>
          <Badge variant={data.webhook.mode === "public" ? "success" : "neutral"}>
            {data.webhook.mode}
          </Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          {app && (
            <Button asChild variant="secondary" size="sm">
              <a href={app.installUrl} target="_blank" rel="noreferrer">
                Install on GitHub
              </a>
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            {refresh.isPending ? "Refreshing…" : "Refresh installations"}
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            disabled={deleteApp.isPending}
            onClick={() => {
              if (!confirm("Remove the GitHub App? Sessions using it for repo access will lose that access.")) {
                return;
              }
              deleteApp.mutate();
            }}
          >
            {deleteApp.isPending ? "Removing…" : "Remove App"}
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted">Installations</h3>
        {data.installations.length === 0 ? (
          <p className="text-sm text-muted">No installations yet.</p>
        ) : (
          <div className="divide-y divide-line border-t border-line">
            {data.installations.map((inst) => (
              <div key={inst.id} className="flex items-center gap-3 py-3 text-sm">
                <div className="min-w-0 flex-1 truncate font-medium text-ink">
                  {inst.accountLogin}
                </div>
                <div className="w-28 shrink-0 text-xs text-muted">{inst.accountType}</div>
                <div className="w-20 shrink-0 text-xs text-muted">
                  {inst.repositorySelection ?? "—"}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {inst.suspended && <Badge variant="danger">Suspended</Badge>}
                  {inst.linkedUserId && <Badge variant="accent">Linked</Badge>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
