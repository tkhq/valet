import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useOrg } from "~/api/settings";
import { usePatchArtifact, useRevokeArtifact, useArtifacts, useShareArtifact } from "~/api/artifacts";
import { Button, Switch } from "~/components/primitives";
import { useCopyToClipboard } from "~/lib/use-copy";

/**
 * The human half of artifact sharing (artifacts design). Collapsed to one
 * "Share" button; expanded, it shows the link, the audience control, and
 * revoke. The `public` option is disabled (with the corrective hint) until
 * an org admin enables `allowPublicArtifacts` in Settings → Organization.
 *
 * Rendered from `MemoryDoc`'s action row, so it appears on the `/memory`
 * page and inside the chat memory-viewer dialog alike. Both queries are
 * gated on the panel being open — a doc render shouldn't cost an org or
 * artifact-list request.
 */
export function ShareControls({ path }: { path: string }) {
  const [panelOpen, setPanelOpen] = useState(false);
  const { copied, copy } = useCopyToClipboard();
  const orgQ = useOrg({ enabled: panelOpen });
  const artifactsQ = useArtifacts({ enabled: panelOpen });
  const shareMutation = useShareArtifact();
  const patchMutation = usePatchArtifact();
  const revokeMutation = useRevokeArtifact();

  const artifact = artifactsQ.data?.artifacts.find((a) => a.path === path && !a.revoked);
  const allowPublic = orgQ.data?.allowPublicArtifacts ?? false;
  const busy = shareMutation.isPending || patchMutation.isPending || revokeMutation.isPending;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setPanelOpen((v) => !v)}
        aria-expanded={panelOpen}
        className="text-muted hover:text-moss"
      >
        Share
      </button>
      {panelOpen && (
        <div className="absolute right-0 top-full z-10 mt-1 w-80 space-y-3 rounded-lg border border-line bg-[--bg] p-3 text-left shadow-xl">
          {artifact ? (
            <>
              <div className="flex items-center gap-1.5">
                <input
                  readOnly
                  value={artifact.url}
                  onFocus={(e) => e.currentTarget.select()}
                  className="min-w-0 flex-1 rounded border border-line bg-transparent px-2 py-1 font-mono text-[11px]"
                  aria-label="Share link"
                />
                <button
                  type="button"
                  onClick={() => void copy(artifact.url)}
                  className="rounded p-1.5 text-muted hover:text-moss"
                  aria-label="Copy share link"
                >
                  {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
                </button>
              </div>
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted">Anyone with the link</span>
                <Switch
                  checked={artifact.visibility === "public"}
                  disabled={busy || (!allowPublic && artifact.visibility !== "public")}
                  onCheckedChange={(next) =>
                    patchMutation.mutate({ id: artifact.id, visibility: next ? "public" : "org" })
                  }
                  aria-label="Allow anyone with the link"
                />
              </div>
              <p className="text-[11px] text-muted">
                {artifact.visibility === "public" && allowPublic
                  ? "Anyone with the link can read this — no login."
                  : "Logged-in members of your org can open the link."}
                {!allowPublic && (
                  <>
                    {" "}
                    Public sharing is off for this organization. An org admin can enable it in Settings →
                    Organization.
                  </>
                )}
              </p>
              <div className="flex items-center justify-between">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => shareMutation.mutate({ path })}
                  title="Publish the file's current content to the existing link"
                >
                  Update snapshot
                </Button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => revokeMutation.mutate({ id: artifact.id })}
                  className="text-xs text-danger-500 hover:underline"
                >
                  Revoke link
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-muted">
                Create a link to this document. It serves a snapshot of the current content to logged-in
                members of your org.
              </p>
              <Button size="sm" disabled={busy || artifactsQ.isLoading} onClick={() => shareMutation.mutate({ path })}>
                {shareMutation.isPending ? "Sharing…" : "Create share link"}
              </Button>
            </>
          )}
          {(shareMutation.error || patchMutation.error || revokeMutation.error) && (
            <p className="text-[11px] text-danger-500">
              {(shareMutation.error ?? patchMutation.error ?? revokeMutation.error)?.message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
