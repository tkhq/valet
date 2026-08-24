import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  FileOutput,
  History,
  Maximize,
  MessageSquarePlus,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { DesignRevisionSummary } from "@valet/api/wire";
import { api, ApiError } from "~/api/client";
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
import { Button, Dialog, DialogContent, DialogFooter, Spinner } from "~/components/primitives";
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
 * Export options (the Claude Design model): every option carries a
 * description and an Instant / Uses-agent badge, so the modal explains
 * what each download actually is before anything happens. Instant options
 * download straight from the browser; agent options run in chat and open
 * the ExportManifest approval gate.
 */
interface ExportOption {
  id: string;
  label: string;
  badge: "instant" | "agent";
  description: string;
  /** Instant: a download URL or print view. Agent: the chat request. */
  action:
    | { kind: "download"; format: "dc" | "html" }
    | { kind: "print" }
    | { kind: "agent"; prompt: string };
  /** Only shown for slides artifacts. */
  slidesOnly?: boolean;
}

const EXPORT_OPTIONS: ExportOption[] = [
  {
    id: "html",
    label: "Standalone HTML",
    badge: "instant",
    description:
      "One self-contained file that opens anywhere, even offline. Slide decks include a built-in viewer: arrow keys to navigate, \u201cs\u201d for speaker notes.",
    action: { kind: "download", format: "html" },
  },
  {
    id: "dc",
    label: "Design file (.dc.html)",
    badge: "instant",
    description: "The raw design document — re-import it into another design session, or hand it to a coding agent.",
    action: { kind: "download", format: "dc" },
  },
  {
    id: "project",
    label: "Project folder",
    badge: "agent",
    description:
      "The deck, your agent's scratchpad, and the design system (tokens + guide) written into the session workspace as a folder.",
    action: { kind: "agent", prompt: "Export the design as a project folder." },
  },
  {
    id: "pdf",
    label: "PDF",
    badge: "instant",
    description:
      "Opens a print view in a new tab with one slide per page — choose \u201cSave as PDF\u201d in the print dialog. Full fidelity, nothing to install.",
    action: { kind: "print" },
  },
  {
    id: "pptx",
    label: "PowerPoint (.pptx)",
    badge: "agent",
    description: "Editable slides via marp-cli (needs the design sandbox image with Chromium).",
    action: { kind: "agent", prompt: "Export the design as pptx." },
    slidesOnly: true,
  },
  {
    id: "gslides",
    label: "Google Slides",
    badge: "agent",
    description:
      "Creates a presentation in your connected Google Drive; element ids survive the round trip so you can import edits back.",
    action: { kind: "agent", prompt: "Export the design to Google Slides." },
    slidesOnly: true,
  },
];

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

// Slide previews are the real DesignRenderer in stage mode: the renderer
// fit-scales the fixed 1920×1080 stage into the thumb box, so a thumbnail
// can never drift from what the slide actually looks like.
function SlideThumb({
  content,
  tokens,
  index,
}: {
  content: string;
  tokens: Record<string, string>;
  index: number;
}) {
  return (
    <div className="pointer-events-none w-full overflow-hidden rounded bg-white dark:bg-neutral-950">
      <DesignRenderer content={content} tokens={tokens} activeSlideIndex={index} />
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
  const [exportOpen, setExportOpen] = useState(false);
  const [exportChoice, setExportChoice] = useState<string>("html");
  const [commentMode, setCommentMode] = useState(false);
  const [commentVdid, setCommentVdid] = useState<string | null>(null);
  const [activeSlide, setActiveSlide] = useState(0);
  const canvasRef = useRef<HTMLDivElement>(null);
  // Dedupe render-health posts: one report per (revision, measurement).
  const lastHealthKey = useRef("");
  // Slide count for the keyboard-navigation listener (bound once).
  const slidesRef = useRef(0);
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

  // Keyboard slide navigation (Claude Design parity): arrows and page keys
  // move between slides. Never while typing — the chat input and the
  // comment form own their own keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const total = slidesRef.current;
      if (total === 0) return;
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        setActiveSlide((i) => Math.min(total - 1, i + 1));
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        setActiveSlide((i) => Math.max(0, i - 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const content = artifactQ.data?.content;
  const isSlides = artifactQ.data?.template === "slides";
  const slides = useMemo<SlideInfo[]>(
    () => (isSlides && content ? parseSlides(sanitizeDesignHtml(content)) : []),
    [isSlides, content],
  );
  slidesRef.current = slides.length;
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

  /** Send a message into the session thread (optimistic, same path the
   * chat input uses) — how canvas controls talk to the agent. */
  async function sendToAgent(text: string) {
    if (newestThreadId) {
      const optimisticId = addUserMessage(sessionId, text, newestThreadId);
      const res = await sendPrompt.mutateAsync({ text, threadId: newestThreadId });
      if (res.messageId) setMessageQueueItemId(sessionId, optimisticId, res.messageId);
    } else {
      await sendPrompt.mutateAsync({ text });
    }
  }

  /**
   * Post the comment, then say it in the chat so the agent sees it — the
   * comment row alone never reaches the model.
   */
  async function submitComment(vdid: string, body: string) {
    const created = await addComment.mutateAsync({ vdid, body });
    await sendToAgent(`Comment on element [data-vdid=${vdid}] (comment id ${created.id}): ${body}`);
    setCommentVdid(null);
    setCommentMode(false);
  }

  /** Run the chosen export: instant options download from the API;
   * agent options run in chat behind the ExportManifest gate. */
  function runExport(option: ExportOption) {
    setExportOpen(false);
    const base = `/api/sessions/${encodeURIComponent(sessionId)}/design/download`;
    if (option.action.kind === "download") {
      window.location.href = `${base}?format=${option.action.format}`;
    } else if (option.action.kind === "print") {
      window.open(`${base}?format=html&vd-print=1`, "_blank", "noopener");
    } else {
      void sendToAgent(option.action.prompt);
    }
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
        <Button variant="ghost" size="sm" onClick={() => setExportOpen(true)}>
          <FileOutput className="h-4 w-4" aria-hidden />
          <span>Export</span>
        </Button>
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
              onRenderHealth={(health) => {
                const revision = artifactQ.data?.revision;
                if (!revision) return;
                const key = `${revision}:${JSON.stringify(health)}`;
                if (key === lastHealthKey.current) return;
                lastHealthKey.current = key;
                // Fire-and-forget: the report is a freshness signal for
                // design_read, never worth blocking the canvas over.
                void api.postDesignHealth(sessionId, { revision, ...health }).catch(() => {});
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

        {/* Export modal: one entry point, every option described. */}
        <Dialog open={exportOpen} onOpenChange={setExportOpen}>
          <DialogContent title="Export design">
            <div className="space-y-1" role="radiogroup" aria-label="Export format">
              {EXPORT_OPTIONS.filter((o) => isSlides || !o.slidesOnly).map((opt) => (
                <label
                  key={opt.id}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded border p-3",
                    exportChoice === opt.id ? "border-moss bg-moss-wash/40" : "border-line hover:bg-ink-wash",
                  )}
                >
                  <input
                    type="radio"
                    name="export-format"
                    className="mt-1 accent-[var(--moss)]"
                    checked={exportChoice === opt.id}
                    onChange={() => setExportChoice(opt.id)}
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="text-sm font-medium text-ink">{opt.label}</span>
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-medium",
                          opt.badge === "instant"
                            ? "bg-success-wash text-ink"
                            : "bg-moss-wash text-moss",
                        )}
                      >
                        {opt.badge === "instant" ? "Instant" : "Uses agent"}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-xs text-muted">{opt.description}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-3 text-[11px] text-muted">
              Agent exports run in the chat and open an approval gate naming everything that leaves.
            </p>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setExportOpen(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  const opt = EXPORT_OPTIONS.find((o) => o.id === exportChoice);
                  if (opt) runExport(opt);
                }}
              >
                Export
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

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
