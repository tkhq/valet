import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Check, Copy, ExternalLink, Share2 } from "lucide-react";
import { useOrg } from "~/api/settings";
import { usePatchArtifact, useRevokeArtifact, useArtifacts, useShareArtifact } from "~/api/artifacts";
import { Button, Dialog, DialogContent, DialogTitle, Switch } from "~/components/primitives";
import { MemoryDoc } from "./memory-doc";

/**
 * Full-page memory reader that opens INSIDE a chat session (artifacts +
 * memory viewer design): a large dialog around the same `MemoryDoc` the
 * `/memory` route renders, so reading a long file or following its
 * cross-references never navigates away from the conversation.
 *
 * Cross-references navigate within the dialog (a local path stack with a
 * back button); "Open in Memory" jumps to the full two-pane page. The
 * share controls live here too — this is where the human-only half of
 * artifact sharing (widen to public, revoke) happens.
 *
 * Unlike `MemoryDoc` (router-free by convention), this component calls
 * `useNavigate`: it is only ever mounted inside the routed app, and lazily
 * (`open` consumers render it on demand), so renderer unit tests never
 * instantiate it without a router.
 */
export function MemoryViewerDialog({
  path,
  open,
  onOpenChange,
}: {
  path: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  // Path stack for in-dialog cross-reference navigation. Re-seeded
  // whenever the dialog is (re)opened on a new path.
  const [stack, setStack] = useState<string[]>([path]);
  useEffect(() => {
    setStack([path]);
  }, [path, open]);
  const current = stack[stack.length - 1] ?? path;

  const memoryHref = `/memory/${current.split("/").map(encodeURIComponent).join("/")}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-5xl w-[92vw] h-[88vh] max-h-[88vh] p-0 gap-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden"
        aria-describedby={undefined}
      >
        <header className="flex items-center gap-2 border-b border-line px-4 py-2.5 pr-12">
          {stack.length > 1 && (
            <button
              type="button"
              onClick={() => setStack((s) => s.slice(0, -1))}
              className="rounded p-1 text-muted hover:text-ink"
              aria-label="Back to previous file"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden />
            </button>
          )}
          <DialogTitle className="min-w-0 flex-1 truncate font-mono text-xs text-muted">
            {current}
          </DialogTitle>
          <ShareControls path={current} />
          <a
            href={memoryHref}
            className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted hover:text-moss"
            title="Open in the full memory explorer"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            Open in Memory
          </a>
        </header>
        <div className="overflow-y-auto">
          <MemoryDoc
            path={current}
            onNavigateToChat={() => {
              onOpenChange(false);
              void navigate({ to: "/chat" });
            }}
            onDeleted={() => onOpenChange(false)}
            onOpenPath={(next) => setStack((s) => [...s, next])}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The human half of artifact sharing. Collapsed to one "Share" button;
 * expanded, it shows the link, the audience control, and revoke. The
 * `public` option is disabled (with the corrective hint) until an org
 * admin enables `allowPublicArtifacts` in Settings → Organization.
 */
function ShareControls({ path }: { path: string }) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const orgQ = useOrg();
  // Fetched only while the panel is open — the dialog itself shouldn't
  // cost a list request per mem_read expansion.
  const artifactsQ = useArtifacts({ enabled: panelOpen });
  const shareMutation = useShareArtifact();
  const patchMutation = usePatchArtifact();
  const revokeMutation = useRevokeArtifact();

  const artifact = artifactsQ.data?.artifacts.find((a) => a.path === path && !a.revoked);
  const allowPublic = orgQ.data?.allowPublicArtifacts ?? false;
  const busy = shareMutation.isPending || patchMutation.isPending || revokeMutation.isPending;

  async function copyUrl(url: string) {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setPanelOpen((v) => !v)}
        aria-expanded={panelOpen}
        className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted hover:text-moss"
      >
        <Share2 className="h-3.5 w-3.5" aria-hidden />
        Share
      </button>
      {panelOpen && (
        <div className="absolute right-0 top-full z-10 mt-1 w-80 space-y-3 rounded-lg border border-line bg-[--bg] p-3 shadow-xl">
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
                  onClick={() => void copyUrl(artifact.url)}
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
