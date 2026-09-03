import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Download, MessageSquare, MessageSquarePlus } from "lucide-react";
import { buildArtifactDocument, type ArtifactAnchorRect } from "@valet/shared";
import {
  useAddArtifactComment,
  useArtifact,
  useArtifactComments,
  useResolveArtifactComment,
} from "~/api/artifacts";
import { ApiError } from "~/api/client";
import { useMe } from "~/api/settings";
import { ArtifactFrame, type ArtifactPick } from "~/components/artifact/artifact-frame";
import {
  ArtifactPins,
  ArtifactThreadPanel,
  CommentComposer,
  groupThreads,
} from "~/components/artifact/artifact-comments";
import { Spinner } from "~/components/primitives";
import { artifactDownloadName, downloadTextFile } from "~/lib/download";
import { relativeTime } from "~/lib/relative-time";

/**
 * `/a/$token` — the published-page reader (artifact-pages design). Public in
 * the same sense as `/login`: listed in the root layout's public set, so it
 * renders standalone with no signed-in chrome. The API decides who may read:
 * `public` artifacts serve anonymously (org opt-in), `org` ones 401 a
 * signed-out caller — which the api client's central 401 handler turns into
 * a `/login` redirect on real-auth deployments.
 *
 * The body is a publish-time snapshot, rendered in a sandboxed frame
 * (`ArtifactFrame`). Logged-in org readers additionally get the comment
 * layer: pick an element, write a comment in app chrome, optionally send it
 * to the session that published the page.
 */
export const Route = createFileRoute("/a/$token")({
  component: ArtifactPage,
});

function ArtifactPage() {
  const { token } = Route.useParams();
  const artifactQ = useArtifact(token);
  const canComment = artifactQ.data?.canComment === true;

  const commentsQ = useArtifactComments(token, { enabled: canComment });
  const meQ = useMe({ enabled: canComment });
  const addComment = useAddArtifactComment(token);
  const resolveComment = useResolveArtifactComment(token);

  const [picking, setPicking] = useState(false);
  const [pendingPick, setPendingPick] = useState<ArtifactPick | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [rects, setRects] = useState<Record<string, ArtifactAnchorRect> | null>(null);

  const threads = useMemo(() => groupThreads(commentsQ.data?.comments ?? []), [commentsQ.data]);
  // Track open-thread anchors AND the in-flight pick: the frame reports
  // fresh rects on its own scroll, and the composer repositions from them —
  // a one-time snapshot would strand the popover on stale coordinates.
  const anchors = useMemo(() => {
    const vdids = threads
      .filter((t) => t.root.vdid !== null && t.root.resolvedAt === null)
      .map((t) => t.root.vdid as string);
    if (pendingPick && !vdids.includes(pendingPick.vdid)) vdids.push(pendingPick.vdid);
    return vdids;
  }, [threads, pendingPick]);
  const openCount = threads.filter((t) => t.root.resolvedAt === null).length;

  // The tab should read as the document, not as the app.
  const title = artifactQ.data?.title;
  const icon = artifactQ.data?.icon;
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = `${icon ? `${icon} ` : ""}${title} · Valet`;
    return () => {
      document.title = previous;
    };
  }, [title, icon]);

  if (artifactQ.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-muted">
        <Spinner /> Loading…
      </div>
    );
  }

  if (artifactQ.error) {
    const status = artifactQ.error instanceof ApiError ? artifactQ.error.status : undefined;
    return (
      <div className="flex min-h-screen items-center justify-center p-8 text-center">
        <div className="max-w-sm space-y-2">
          <h1 className="font-display text-xl text-ink">
            {status === 401 ? "This page needs a login." : "This link doesn't work anymore."}
          </h1>
          <p className="text-sm text-muted">
            {status === 401
              ? "It is shared with a Valet organization. Log in to view it."
              : "The share was revoked, or the link is wrong. Ask the person who sent it for a fresh one."}
          </p>
          {status === 401 && (
            <a
              href={`/login?next=${encodeURIComponent(`/a/${token}`)}`}
              className="inline-block text-sm text-moss hover:underline"
            >
              Go to login
            </a>
          )}
        </div>
      </div>
    );
  }

  const doc = artifactQ.data;
  if (!doc) return null;

  const download = () => {
    if (doc.format === "html") {
      // The shelled document (no comment runtime), so the saved file opens
      // standalone with the same policy and theming the viewer applies.
      const page = buildArtifactDocument({
        title: doc.title,
        content: doc.rendered,
        description: doc.description || undefined,
        icon: doc.icon || undefined,
      });
      downloadTextFile(artifactDownloadName(doc.title, "html"), page, "text/html");
      return;
    }
    downloadTextFile(artifactDownloadName(doc.title, "md"), doc.content, "text/markdown");
  };

  const submitComment = (opts: { body: string; sendToSession: boolean }) => {
    if (!pendingPick) return;
    addComment.mutate(
      { body: opts.body, vdid: pendingPick.vdid, sendToSession: opts.sendToSession },
      {
        onSuccess: () => {
          setPendingPick(null);
          setPanelOpen(true);
        },
      },
    );
  };

  const authorName = meQ.data?.name || meQ.data?.email || "You";

  return (
    <div className="flex h-screen flex-col">
      <header className="border-b border-line px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate font-display text-2xl leading-tight text-ink">
              {doc.icon ? `${doc.icon} ` : ""}
              {doc.title}
            </h1>
            {doc.description && <p className="mt-0.5 text-sm text-muted">{doc.description}</p>}
            <p className="mt-1 text-xs text-muted">
              {doc.sharedBy ? `Shared by ${doc.sharedBy} · ` : "Shared "}
              via Valet · version {doc.version} · updated {relativeTime(doc.updatedAt)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3 pt-1">
            {canComment && (
              <button
                type="button"
                onClick={() => {
                  setPicking((p) => !p);
                  setPendingPick(null);
                }}
                className={`flex items-center gap-1 text-xs ${picking ? "text-moss" : "text-muted hover:text-moss"}`}
                title="Click an element on the page to comment on it"
              >
                <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden />
                {picking ? "Click an element…" : "Comment"}
              </button>
            )}
            {canComment && (
              <button
                type="button"
                onClick={() => setPanelOpen((o) => !o)}
                className="flex items-center gap-1 text-xs text-muted hover:text-moss"
              >
                <MessageSquare className="h-3.5 w-3.5" aria-hidden />
                Comments{openCount > 0 ? ` (${openCount})` : ""}
              </button>
            )}
            <button
              type="button"
              onClick={download}
              className="flex items-center gap-1 text-xs text-muted hover:text-moss"
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              Download
            </button>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <ArtifactFrame
            title={doc.title}
            rendered={doc.rendered}
            icon={doc.icon || undefined}
            description={doc.description || undefined}
            picking={picking}
            anchors={anchors}
            onPick={(pick) => {
              setPendingPick(pick);
              setPicking(false);
            }}
            onRects={(next) => setRects(next)}
            className="absolute inset-0 h-full w-full border-0 bg-transparent"
          />
          {canComment && (
            <ArtifactPins
              threads={threads}
              rects={rects ?? {}}
              onOpenThread={(rootId) => {
                setSelectedThreadId(rootId);
                setPanelOpen(true);
              }}
            />
          )}
          {canComment && (
            <CommentComposer
              pick={
                pendingPick
                  ? { ...pendingPick, rect: rects?.[pendingPick.vdid] ?? pendingPick.rect }
                  : null
              }
              authorName={authorName}
              canSendToSession={commentsQ.data?.canSendToSession === true}
              busy={addComment.isPending}
              onSubmit={submitComment}
              onClose={() => setPendingPick(null)}
            />
          )}
        </div>
        {canComment && panelOpen && (
          <ArtifactThreadPanel
            threads={threads}
            rects={rects}
            selectedThreadId={selectedThreadId}
            canResolve={(thread) =>
              commentsQ.data?.canResolveAll === true || thread.root.authorUserId === meQ.data?.id
            }
            busy={addComment.isPending || resolveComment.isPending}
            onReply={(rootId, body) => addComment.mutate({ body, parentId: rootId })}
            onResolve={(rootId) => resolveComment.mutate({ commentId: rootId })}
            onClose={() => setPanelOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
