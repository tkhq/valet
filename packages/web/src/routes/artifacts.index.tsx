import { createFileRoute, Link } from "@tanstack/react-router";
import type { ArtifactListItem } from "@valet/api/wire";
import { useArtifacts, useRevokeArtifact } from "~/api/artifacts";
import { useMe } from "~/api/settings";
import { EmptyRow, ErrorRow, LoadingRow } from "~/components/primitives";
import { relativeTime } from "~/lib/relative-time";
import { useCopyToClipboard } from "~/lib/use-copy";

/**
 * `/artifacts` — the gallery of pages the caller published (memory docs and
 * agent-generated snapshots alike; see the artifacts design). Revoked
 * artifacts are filtered out: a revoked link is a dead link, not a row to
 * manage from here.
 *
 * `GET /api/artifacts` hands an org ADMIN every member's artifacts (see the
 * warning on `ArtifactListItem.actorUserId`), so this page filters to rows
 * the caller themselves published — otherwise the header copy below ("Pages
 * you published") would be false and Revoke would act on a colleague's link.
 *
 * Rows link in-app with `token` (`/a/$token`), never `url` — `url` is the
 * absolute share link, whose origin is the deployment's public URL, which
 * in dev is the api origin and does not serve the SPA. `url` is correct
 * only for the clipboard copy.
 */
export const Route = createFileRoute("/artifacts/")({ component: ArtifactsPage });

export function ArtifactsPage() {
  const listQ = useArtifacts();
  const meQ = useMe();
  const revoke = useRevokeArtifact();
  const me = meQ.data?.id;
  const loading = listQ.isLoading || meQ.isLoading;
  const artifacts = (listQ.data?.artifacts ?? []).filter((a) => !a.revoked && a.actorUserId === me);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <h1 className="font-display text-2xl text-ink">Artifacts</h1>
        <p className="mt-1 text-sm text-muted">
          Pages you published. A link serves logged-in members of your org unless you made it public.
        </p>

        <div className="mt-6">
          {loading && <LoadingRow label="Loading artifacts…" />}
          {listQ.error && (
            <ErrorRow>Could not load your artifacts. Check that the server is running, then reload.</ErrorRow>
          )}
          {!loading && listQ.data && artifacts.length === 0 && (
            <EmptyRow>Nothing published yet. Ask your agent to publish a page, or share a memory doc.</EmptyRow>
          )}
          {!loading && artifacts.length > 0 && (
            <div className="divide-y divide-line border-t border-line">
              {artifacts.map((artifact) => (
                <ArtifactRow
                  key={artifact.id}
                  artifact={artifact}
                  revoking={revoke.isPending}
                  onRevoke={() => revoke.mutate({ id: artifact.id })}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ArtifactRow({
  artifact,
  revoking,
  onRevoke,
}: {
  artifact: ArtifactListItem;
  revoking: boolean;
  onRevoke: () => void;
}) {
  // Per-row instance: `useCopyToClipboard`'s "Copied" flash is component
  // state, and each row needs its own so copying one doesn't flash every
  // row in the list.
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <Link
        to="/a/$token"
        params={{ token: artifact.token }}
        className="min-w-0 flex-1 rounded px-1 py-0.5 hover:bg-ink-wash"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden>{artifact.icon}</span>
          <span className="min-w-0 flex-1 truncate text-sm text-ink">{artifact.title}</span>
        </div>
        <p className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted">
          <span>{artifact.format}</span>
          <span>·</span>
          <span>version {artifact.sharedVersion ?? artifact.version}</span>
          <span>·</span>
          {artifact.visibility === "public" ? (
            <span className="rounded bg-ink-wash px-1.5 py-0.5">public</span>
          ) : (
            <span>{artifact.visibility}</span>
          )}
          <span>·</span>
          <span>updated {relativeTime(artifact.updatedAt)}</span>
        </p>
      </Link>
      <div className="flex shrink-0 items-center gap-3">
        <button
          type="button"
          onClick={() => void copy(artifact.url)}
          className="text-xs text-muted hover:text-ink"
        >
          {copied ? "Copied" : "Copy link"}
        </button>
        <button
          type="button"
          disabled={revoking}
          onClick={() => {
            if (window.confirm("Revoke this link? Viewers get a 404.")) onRevoke();
          }}
          className="text-xs text-danger-500 hover:underline disabled:pointer-events-none disabled:opacity-50"
        >
          Revoke
        </button>
      </div>
    </div>
  );
}
