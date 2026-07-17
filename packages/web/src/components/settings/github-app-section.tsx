import { useRef, useState } from "react";
import type { GithubAppInstallationSummary, PostGithubAppManifestResponse } from "@valet/api/wire";
import { Badge, Button, Spinner } from "~/components/primitives";
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
    <NotConfiguredCard />
  );
}

function NotConfiguredCard() {
  const createManifest = useCreateGithubAppManifest();
  const [manifest, setManifest] = useState<PostGithubAppManifestResponse | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  async function create() {
    try {
      const res = await createManifest.mutateAsync();
      setManifest(res);
    } catch {
      // useMutation surfaces the error via `createManifest.error`.
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Create a GitHub App for this organization to let the assistant clone and push to your
        repos.
      </p>
      <Button type="button" onClick={() => void create()} disabled={createManifest.isPending}>
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
