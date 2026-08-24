import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  History,
  Maximize,
  MessageSquarePlus,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { DesignRevisionSummary } from "@valet/api/wire";
import { ApiError } from "~/api/client";
import { useSendPrompt, useSession, useThreads } from "~/api/queries";
import {
  qkDesign,
  useAddComment,
  useDesignArtifact,
  useDesignComments,
  useDesignRevisions,
  useDesignTokens,
  useRevertRevision,
} from "~/api/design";
import { useSessionStream, useStreamStore } from "~/stores/stream";
import { DesignRenderer } from "~/components/design/design-renderer";
import { parseSlides, sanitizeDesignHtml, type SlideInfo } from "~/components/design/sanitize";
import { SessionView } from "~/components/session/session-view";
import { Button, Spinner } from "~/components/primitives";
import { relativeTime } from "~/lib/relative-time";
import { cn } from "~/lib/cn";

/**
 * `/sessions/$sessionId/design` — the canvas (Valet Design spec §Web
 * Surfaces; layout mirrors Claude Design). Left: the session chat
 * (`SessionView` in panel mode — the same component `/chat`'s slide-over
 * uses, so message rendering is never forked), width-resizable by drag.
 * Then, for slides templates, a strip of real rendered slide previews.
 * Center: the artifact. Bottom (slides): a height-resizable speaker-notes
 * pane with a slide counter. Panel sizes persist in localStorage.
 *
 * The trailing `_` in the filename opts this route out of nesting under
 * `sessions.$sessionId.tsx`, which renders no Outlet.
 */
export const Route = createFileRoute("/sessions/$sessionId_/design")({
  component: DesignCanvasPage,
});

const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 2];

/**
 * Pointer-drag panel resizing (the Claude Design slider). `invert` is for
 * handles on the far edge of their panel (the notes pane grows as the
 * handle moves UP). The size persists per `storageKey`.
 */
function useDragResize(opts: {
  storageKey: string;
  initial: number;
  min: number;
  max: number;
  axis: "x" | "y";
  invert?: boolean;
}) {
  const [size, setSize] = useState(() => {
    const stored = Number(localStorage.getItem(opts.storageKey));
    return Number.isFinite(stored) && stored >= opts.min && stored <= opts.max
      ? stored
      : opts.initial;
  });
  useEffect(() => {
    localStorage.setItem(opts.storageKey, String(Math.round(size)));
  }, [opts.storageKey, size]);

  const { min, max, axis, invert } = opts;
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    const origin = axis === "x" ? e.clientX : e.clientY;
    const base = size;
    const onMove = (ev: PointerEvent) => {
      const delta = (axis === "x" ? ev.clientX : ev.clientY) - origin;
      setSize(Math.min(max, Math.max(min, base + (invert ? -delta : delta))));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  return { size, start };
}

// Slide previews render the real artifact at a fixed design width, scaled
// into the strip — the same DesignRenderer as the canvas, so a thumbnail
// can never drift from what the slide actually looks like.
const THUMB_W = 144;
const THUMB_RENDER_W = 960;

function SlideThumb({
  content,
  tokens,
  index,
}: {
  content: string;
  tokens: Record<string, string>;
  index: number;
}) {
  const scale = THUMB_W / THUMB_RENDER_W;
  return (
    <div
      className="pointer-events-none w-full overflow-hidden rounded bg-white dark:bg-neutral-950"
      style={{ height: (THUMB_W * 9) / 16 }}
    >
      <div style={{ width: THUMB_RENDER_W, transform: `scale(${scale})`, transformOrigin: "top left" }}>
        <DesignRenderer content={content} tokens={tokens} activeSlideIndex={index} />
      </div>
    </div>
  );
}

function DesignCanvasPage() {
  const { sessionId } = Route.useParams();
  const qc = useQueryClient();
  const session = useSession(sessionId);
  const artifactQ = useDesignArtifact(sessionId);
  const revisionsQ = useDesignRevisions(sessionId);
  const commentsQ = useDesignComments(sessionId);
  const tokensQ = useDesignTokens(sessionId);
  const threads = useThreads(sessionId);
  const stream = useSessionStream(sessionId);
  const revert = useRevertRevision(sessionId);
  const addComment = useAddComment(sessionId);
  const sendPrompt = useSendPrompt(sessionId);
  const addUserMessage = useStreamStore((s) => s.addUserMessage);
  const setMessageQueueItemId = useStreamStore((s) => s.setMessageQueueItemId);

  const [zoomIdx, setZoomIdx] = useState(ZOOM_STEPS.indexOf(1));
  const [historyOpen, setHistoryOpen] = useState(false);
  const [commentMode, setCommentMode] = useState(false);
  const [commentVdid, setCommentVdid] = useState<string | null>(null);
  const [activeSlide, setActiveSlide] = useState(0);
  const canvasRef = useRef<HTMLDivElement>(null);
  const chatPanel = useDragResize({
    storageKey: "vd.chatWidth",
    initial: 340,
    min: 240,
    max: 640,
    axis: "x",
  });
  const notesPanel = useDragResize({
    storageKey: "vd.notesHeight",
    initial: 88,
    min: 44,
    max: 320,
    axis: "y",
    invert: true,
  });

  // Live updates: design.* WS frames carry metadata only; refetch over REST
  // when the stream store reports one (locked decision 3's shape — REST is
  // authoritative, the wire is a doorbell).
  const liveArtifact = stream.designArtifact;
  useEffect(() => {
    if (!liveArtifact) return;
    void qc.invalidateQueries({ queryKey: qkDesign.artifact(sessionId) });
    void qc.invalidateQueries({ queryKey: qkDesign.revisions(sessionId) });
  }, [liveArtifact, sessionId, qc]);
  const commentsNonce = stream.designCommentsNonce;
  useEffect(() => {
    if (!commentsNonce) return;
    void qc.invalidateQueries({ queryKey: qkDesign.comments(sessionId) });
  }, [commentsNonce, sessionId, qc]);

  const content = artifactQ.data?.content;
  const isSlides = artifactQ.data?.template === "slides";
  const slides = useMemo<SlideInfo[]>(
    () => (isSlides && content ? parseSlides(sanitizeDesignHtml(content)) : []),
    [isSlides, content],
  );
  // A revision can add or drop slides — keep the selection in range.
  useEffect(() => {
    if (slides.length > 0 && activeSlide >= slides.length) {
      setActiveSlide(slides.length - 1);
    }
  }, [slides.length, activeSlide]);

  // Unresolved-comment counts by vdid, for the badge overlays.
  const commentCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const comment of commentsQ.data?.comments ?? []) {
      if (comment.resolvedAt !== null) continue;
      counts[comment.vdid] = (counts[comment.vdid] ?? 0) + 1;
    }
    return counts;
  }, [commentsQ.data]);

  // The newest thread — same rule `SessionView` applies — so the comment
  // chat message lands in the thread the sidebar shows.
  const newestThreadId = threads.data?.threads.reduce<
    { id: string; createdAt: number } | undefined
  >(
    (best, t) =>
      best === undefined || t.createdAt > best.createdAt
        ? { id: t.id, createdAt: t.createdAt }
        : best,
    undefined,
  )?.id;

  /**
   * Post the comment, then say it in the chat so the agent sees it — the
   * comment row alone never reaches the model.
   */
  async function submitComment(vdid: string, body: string) {
    const created = await addComment.mutateAsync({ vdid, body });
    const text = `Comment on element [data-vdid=${vdid}] (comment id ${created.id}): ${body}`;
    if (newestThreadId) {
      const optimisticId = addUserMessage(sessionId, text, newestThreadId);
      const res = await sendPrompt.mutateAsync({ text, threadId: newestThreadId });
      if (res.messageId) setMessageQueueItemId(sessionId, optimisticId, res.messageId);
    } else {
      await sendPrompt.mutateAsync({ text });
    }
    setCommentVdid(null);
    setCommentMode(false);
  }

  if (session.isLoading || artifactQ.isLoading) {
    return (
      <div className="flex-1 grid place-items-center text-sm text-muted">
        <Spinner /> Loading design…
      </div>
    );
  }

  // Wrong kind, or no artifact (404): a clear road back, not a blank canvas.
  const artifactMissing =
    artifactQ.error instanceof ApiError && artifactQ.error.status === 404;
  if ((session.data && session.data.kind !== "design") || artifactMissing) {
    return (
      <div className="flex-1 grid place-items-center p-8 text-center">
        <div className="max-w-sm space-y-3">
          <h1 className="text-lg font-semibold text-ink">No design canvas here</h1>
          <p className="text-sm text-muted">
            {session.data && session.data.kind !== "design"
              ? "This is a code session, and it has no design artifact."
              : "This session has no design artifact yet."}
          </p>
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId }}
            className="inline-flex rounded px-3 py-1.5 text-sm text-moss hover:underline"
          >
            Open the session page
          </Link>
        </div>
      </div>
    );
  }

  if (artifactQ.error || !artifactQ.data) {
    return (
      <div className="flex-1 grid place-items-center text-center text-sm p-8">
        <div>
          <div className="text-danger-500">The design did not load. Retry, or reload the page.</div>
          <div className="text-xs text-muted mt-1">
            {artifactQ.error instanceof Error ? artifactQ.error.message : null}
          </div>
          <button
            type="button"
            className="mt-3 rounded border border-line px-3 py-1 text-xs hover:bg-ink-wash"
            onClick={() => void artifactQ.refetch()}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const zoom = ZOOM_STEPS[zoomIdx];

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Top bar */}
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2">
        <Link
          to="/sessions/$sessionId"
          params={{ sessionId }}
          className="min-w-0 truncate text-sm font-semibold tracking-tight text-ink hover:text-moss"
          title="Open the session page"
        >
          {session.data?.title || "Untitled design"}
        </Link>
        <span className="shrink-0 rounded bg-ink-wash px-1.5 py-0.5 font-mono text-[10px] text-muted">
          {artifactQ.data.revision}
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Zoom out"
            disabled={zoomIdx === 0}
            onClick={() => setZoomIdx((i) => Math.max(0, i - 1))}
          >
            <ZoomOut className="h-4 w-4" />
          </Button>
          <span className="w-10 text-center font-mono text-[11px] text-muted">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Zoom in"
            disabled={zoomIdx === ZOOM_STEPS.length - 1}
            onClick={() => setZoomIdx((i) => Math.min(ZOOM_STEPS.length - 1, i + 1))}
          >
            <ZoomIn className="h-4 w-4" />
          </Button>
        </div>
        <Button
          variant={commentMode ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={commentMode}
          onClick={() => {
            setCommentMode((v) => !v);
            setCommentVdid(null);
          }}
        >
          <MessageSquarePlus className="h-4 w-4" aria-hidden />
          <span>Comment</span>
        </Button>
        <Button
          variant={historyOpen ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={historyOpen}
          onClick={() => setHistoryOpen((v) => !v)}
        >
          <History className="h-4 w-4" aria-hidden />
          <span>History</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void canvasRef.current?.requestFullscreen()}
        >
          <Maximize className="h-4 w-4" aria-hidden />
          <span>Present</span>
        </Button>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Session chat — the same view every other surface uses. */}
        <aside
          style={{ width: chatPanel.size }}
          className="hidden shrink-0 border-r border-line md:flex md:flex-col md:min-h-0"
        >
          <SessionView sessionId={sessionId} panel />
        </aside>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the chat panel"
          onPointerDown={chatPanel.start}
          className="hidden w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-moss/40 active:bg-moss/60 md:block"
        />

        {/* Slide previews (slides template only) */}
        {isSlides && (
          <nav
            aria-label="Slides"
            className="w-44 shrink-0 overflow-y-auto border-r border-line bg-neutral-100 p-3 space-y-3 dark:bg-neutral-900"
          >
            {slides.map((slide) => (
              <button
                key={slide.index}
                type="button"
                title={slide.heading}
                aria-label={`Slide ${slide.index + 1}: ${slide.heading}`}
                aria-current={slide.index === activeSlide}
                onClick={() => setActiveSlide(slide.index)}
                className="flex w-full items-start gap-1.5 text-left"
              >
                <span
                  className={cn(
                    "w-4 shrink-0 pt-0.5 text-right font-mono text-[10px]",
                    slide.index === activeSlide ? "text-ink font-semibold" : "text-muted",
                  )}
                >
                  {slide.index + 1}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 rounded ring-offset-1",
                    slide.index === activeSlide
                      ? "ring-2 ring-moss"
                      : "ring-1 ring-line hover:ring-moss/50",
                  )}
                >
                  <SlideThumb
                    content={artifactQ.data.content}
                    tokens={tokensQ.data?.tokens ?? {}}
                    index={slide.index}
                  />
                </span>
              </button>
            ))}
          </nav>
        )}

        {/* Canvas */}
        <div className="relative flex flex-1 flex-col min-h-0 min-w-0">
          <div
            ref={canvasRef}
            className="flex-1 overflow-auto bg-neutral-100 p-6 dark:bg-neutral-900"
          >
            <DesignRenderer
              content={artifactQ.data.content}
              tokens={tokensQ.data?.tokens ?? {}}
              activeSlideIndex={isSlides ? activeSlide : undefined}
              zoom={zoom}
              commentCounts={commentCounts}
              commentMode={commentMode}
              onElementClick={(vdid) => {
                if (commentMode) setCommentVdid(vdid);
              }}
              className="mx-auto max-w-4xl rounded bg-white shadow dark:bg-neutral-950"
            />
          </div>

          {commentMode && !commentVdid && (
            <div className="pointer-events-none absolute inset-x-0 top-2 mx-auto w-fit rounded bg-neutral-900/80 px-3 py-1 text-xs text-white">
              Select an element to comment on it.
            </div>
          )}

          {commentVdid && (
            <CommentForm
              vdid={commentVdid}
              pending={addComment.isPending || sendPrompt.isPending}
              error={addComment.error?.message ?? sendPrompt.error?.message}
              onCancel={() => setCommentVdid(null)}
              onSubmit={(body) => void submitComment(commentVdid, body)}
            />
          )}

          {/* Speaker notes (slides template only), height-resizable. */}
          {isSlides && (
            <>
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize the speaker notes"
                onPointerDown={notesPanel.start}
                className="h-1 shrink-0 cursor-row-resize border-t border-line bg-transparent transition-colors hover:bg-moss/40 active:bg-moss/60"
              />
              <div
                style={{ height: notesPanel.size }}
                className="shrink-0 overflow-y-auto bg-paper px-4 py-2"
              >
                <div className="text-[10px] uppercase tracking-wider text-muted">
                  Speaker notes — slide {activeSlide + 1}/{slides.length}
                </div>
                <p className="mt-0.5 min-h-[1.25rem] whitespace-pre-wrap text-xs text-ink">
                  {slides[activeSlide]?.notes || "No notes for this slide."}
                </p>
              </div>
            </>
          )}
        </div>

        {/* History panel */}
        {historyOpen && (
          <HistoryPanel
            revisions={revisionsQ.data?.revisions ?? []}
            current={revisionsQ.data?.current}
            pending={revert.isPending}
            error={revert.error?.message}
            onRevert={(revision) => revert.mutate({ revision })}
          />
        )}
      </div>
    </div>
  );
}

function CommentForm({
  vdid,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  vdid: string;
  pending: boolean;
  error?: string;
  onCancel: () => void;
  onSubmit: (body: string) => void;
}) {
  const [body, setBody] = useState("");
  return (
    <div className="absolute inset-x-0 bottom-4 mx-auto w-[22rem] rounded border border-line bg-paper p-3 shadow-lg">
      <div className="mb-2 text-xs text-muted">
        Comment on <span className="font-mono text-ink">[data-vdid={vdid}]</span>
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        autoFocus
        rows={3}
        placeholder="What should change here?"
        aria-label="Comment text"
        className="w-full resize-none rounded border border-line bg-paper px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-moss"
      />
      {error && <div className="mt-1 text-xs text-danger-600">{error}</div>}
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button size="sm" disabled={pending || !body.trim()} onClick={() => onSubmit(body.trim())}>
          {pending ? "Posting…" : "Comment"}
        </Button>
      </div>
    </div>
  );
}

function HistoryPanel({
  revisions,
  current,
  pending,
  error,
  onRevert,
}: {
  revisions: DesignRevisionSummary[];
  current: string | undefined;
  pending: boolean;
  error?: string;
  onRevert: (revision: string) => void;
}) {
  // Newest first — the list answers "what changed lately".
  const ordered = [...revisions].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <aside className="flex w-64 shrink-0 flex-col border-l border-line" aria-label="Revision history">
      <div className="border-b border-line px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted">
        History
      </div>
      {error && <div className="px-3 py-2 text-xs text-danger-600">{error}</div>}
      <ul className="flex-1 overflow-y-auto">
        {ordered.length === 0 && (
          <li className="px-3 py-2 text-xs text-muted">No revisions yet.</li>
        )}
        {ordered.map((rev) => {
          const isCurrent = rev.revision === current;
          return (
            <li key={rev.revision} className="border-b border-line/60 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-ink">{rev.revision}</span>
                {isCurrent && (
                  <span className="rounded bg-moss-wash px-1.5 py-0.5 text-[10px] font-medium text-moss">
                    current
                  </span>
                )}
                <span className="ml-auto shrink-0 text-[10px] text-muted">
                  {relativeTime(rev.createdAt)}
                </span>
              </div>
              {rev.summary && <div className="mt-0.5 text-xs text-muted">{rev.summary}</div>}
              {!isCurrent && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-1.5"
                  disabled={pending}
                  onClick={() => onRevert(rev.revision)}
                >
                  Revert to this
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
