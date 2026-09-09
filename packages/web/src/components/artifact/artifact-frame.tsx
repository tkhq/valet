/**
 * The published-artifact renderer (artifact-pages design): a sandboxed iframe
 * around the shell that `buildArtifactDocument` produces.
 *
 * Security model, in one place: the sandbox omits `allow-same-origin`, so the
 * document runs in an opaque origin — it cannot read the app's cookies or
 * storage, cannot reach `window.parent`'s DOM, and sends no credentials. The
 * shell's CSP additionally denies all network egress (`connect-src 'none'`).
 * The comment bridge below is a convenience, never a boundary: a hostile page
 * can fabricate picks and rects, and the worst it achieves is a mispositioned
 * pin over its own render — comment text is composed, stored, and displayed
 * entirely outside the frame.
 */
import { useEffect, useMemo, useRef } from "react";
import {
  ARTIFACT_FRAME_SANDBOX,
  buildArtifactDocument,
  type ArtifactAnchorRect,
} from "@valet/shared";
import { renderMermaid } from "~/lib/mermaid";
import { useMermaidTheme } from "~/lib/use-mermaid-theme";

export interface ArtifactPick {
  vdid: string;
  rect: ArtifactAnchorRect;
  label: string;
}

interface ArtifactFrameProps {
  title: string;
  /** The compiled page body from the api (`GetArtifactResponse.rendered`). */
  rendered: string;
  icon?: string;
  description?: string;
  /** Element-pick mode: the frame outlines hover targets and reports clicks. */
  picking?: boolean;
  /** vdids whose rects the frame should keep reporting (comment pins). */
  anchors?: string[];
  onPick?: (pick: ArtifactPick) => void;
  onRects?: (rects: Record<string, ArtifactAnchorRect>) => void;
  className?: string;
  /** Viewer theme stamped into the page: explicit choice, or null/undefined for system. */
  theme?: "light" | "dark" | null;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function asRect(v: unknown): ArtifactAnchorRect | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (!isFiniteNumber(r.top) || !isFiniteNumber(r.left) || !isFiniteNumber(r.width) || !isFiniteNumber(r.height)) {
    return null;
  }
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

const VDID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_PENDING_MERMAID_REQUESTS = 32;
export const MAX_COMPLETED_MERMAID_REQUESTS = 32;

type MermaidRender = (
  source: string,
  id: string,
  theme: "default" | "dark",
  isCurrent: () => boolean,
) => Promise<string>;
type MermaidResult =
  | { type: "valet-artifact:mermaid-result"; id: string; svg: string }
  | { type: "valet-artifact:mermaid-result"; id: string; error: true };

interface MermaidRequest {
  blockId: string;
  source: string;
  theme: "default" | "dark";
}

/**
 * Keep at most one active render and a fixed number of replacement requests
 * per artifact frame. Frame content is untrusted, so it can send messages as
 * quickly as it wants. Only the latest source for each block is useful.
 */
export class ArtifactMermaidCoordinator {
  private active: MermaidRequest | undefined;
  private readonly pending = new Map<string, MermaidRequest>();
  private readonly completed = new Map<string, MermaidRequest>();
  private nextRenderId = 0;
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly render: MermaidRender,
    private readonly postResult: (result: MermaidResult) => void,
  ) {}

  request(blockId: string, source: string, theme: "default" | "dark"): void {
    if (this.disposed) return;
    const request = { blockId, source, theme };
    if (this.sameRequest(this.active, request) || this.sameRequest(this.pending.get(blockId), request)) {
      return;
    }
    // A pending replacement is newer than a completed result. Never let the
    // completed cache discard a request that restores an earlier theme.
    if (
      (!this.active || this.active.blockId !== blockId) &&
      !this.pending.has(blockId) &&
      this.sameRequest(this.completed.get(blockId), request)
    ) {
      return;
    }
    this.completed.delete(blockId);
    if (!this.pending.has(blockId) && this.pending.size === MAX_PENDING_MERMAID_REQUESTS) {
      // Keep the newest request for an active block. A result for an older
      // theme or source must not win just because other blocks filled the cap.
      if (this.active?.blockId !== blockId) return;
      const oldestBlockId = this.pending.keys().next().value;
      if (oldestBlockId) this.pending.delete(oldestBlockId);
    }
    this.pending.set(blockId, request);
    this.startNext();
  }

  clear(): void {
    this.generation += 1;
    this.active = undefined;
    this.pending.clear();
    this.completed.clear();
  }

  dispose(): void {
    this.clear();
    this.disposed = true;
  }

  private sameRequest(current: MermaidRequest | undefined, request: MermaidRequest): boolean {
    return current?.blockId === request.blockId && current.source === request.source && current.theme === request.theme;
  }

  private startNext(): void {
    if (this.disposed || this.active || this.pending.size === 0) return;
    const next = this.pending.entries().next().value;
    if (!next) return;
    const [blockId, request] = next;
    this.pending.delete(blockId);
    this.active = request;
    const generation = this.generation;
    const renderId = `artifact-mermaid-${++this.nextRenderId}`;

    const isCurrent = () =>
      !this.disposed &&
      generation === this.generation &&
      this.active === request &&
      !this.pending.has(request.blockId);
    void this.render(request.source, renderId, request.theme, isCurrent).then(
      (svg) => this.finish(request, generation, { type: "valet-artifact:mermaid-result", id: blockId, svg }),
      () => this.finish(request, generation, { type: "valet-artifact:mermaid-result", id: blockId, error: true }),
    );
  }

  private finish(request: MermaidRequest, generation: number, result: MermaidResult): void {
    if (this.active === request) this.active = undefined;
    if (
      !this.disposed &&
      generation === this.generation &&
      !this.pending.has(request.blockId)
    ) {
      this.rememberCompleted(request);
      this.postResult(result);
    }
    this.startNext();
  }

  private rememberCompleted(request: MermaidRequest): void {
    this.completed.delete(request.blockId);
    this.completed.set(request.blockId, request);
    if (this.completed.size > MAX_COMPLETED_MERMAID_REQUESTS) {
      const oldestBlockId = this.completed.keys().next().value;
      if (oldestBlockId) this.completed.delete(oldestBlockId);
    }
  }
}

export function ArtifactFrame({
  title,
  rendered,
  icon,
  description,
  picking = false,
  anchors,
  onPick,
  onRects,
  className,
  theme,
}: ArtifactFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const post = (message: unknown) => {
    // "*" is the only addressable target: an opaque origin has no name. The
    // payloads carry mode flags and vdids, nothing secret.
    frameRef.current?.contentWindow?.postMessage(message, "*");
  };
  const mermaidCoordinatorRef = useRef<ArtifactMermaidCoordinator | null>(null);
  mermaidCoordinatorRef.current ??= new ArtifactMermaidCoordinator(renderMermaid, post);
  const mermaidCoordinator = mermaidCoordinatorRef.current;
  const readyRef = useRef(false);
  const mermaidTheme = useMermaidTheme();
  const mermaidThemeRef = useRef(mermaidTheme);
  mermaidThemeRef.current = mermaidTheme;
  // Live refs so the message listener never rebinds mid-load (rebinding can
  // drop the `ready` handshake and strand the bridge).
  const onPickRef = useRef(onPick);
  const onRectsRef = useRef(onRects);
  onPickRef.current = onPick;
  onRectsRef.current = onRects;
  const pickingRef = useRef(picking);
  const anchorsRef = useRef(anchors);
  // The theme stamped into `srcDoc` is frozen at whatever `themeRef` holds
  // when the memo below runs — mount, or the next time `title`/`rendered`/
  // `icon`/`description` change. A later theme flip alone restamps via
  // postMessage instead of reloading the frame (`theme` stays OUT of the
  // memo deps), so script state survives; this ref carries the CURRENT
  // value for both that restamp and the next srcDoc build. This render-time
  // write is load-bearing: it is the ONLY assignment that runs before the
  // `srcDoc` memo below on every render, so the memo always sees the theme
  // as of THIS render, not a stale one from the last `[theme]` effect.
  const themeRef = useRef(theme);
  themeRef.current = theme;

  const srcDoc = useMemo(
    () =>
      buildArtifactDocument({
        title,
        content: rendered,
        icon,
        description,
        runtime: true,
        theme: themeRef.current ?? undefined,
      }),
    [title, rendered, icon, description],
  );

  // A srcDoc change reloads the frame's document, so the bridge starts over.
  useEffect(() => {
    readyRef.current = false;
    mermaidCoordinator.clear();
  }, [srcDoc]);

  useEffect(() => () => mermaidCoordinator.dispose(), [mermaidCoordinator]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Only the frame's own window — every other source is untrusted app
      // context or another tab.
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const data: unknown = e.data;
      if (typeof data !== "object" || data === null) return;
      const msg = data as Record<string, unknown>;
      if (msg.type === "valet-artifact:ready") {
        readyRef.current = true;
        post({ type: "valet-artifact:mode", picking: pickingRef.current });
        if (anchorsRef.current && anchorsRef.current.length > 0) {
          post({ type: "valet-artifact:anchors", vdids: anchorsRef.current });
        }
        post({ type: "valet-artifact:theme", theme: themeRef.current ?? null });
        return;
      }
      if (msg.type === "valet-artifact:mermaid") {
        if (
          typeof msg.id !== "string" ||
          !/^mermaid-\d{1,3}$/.test(msg.id) ||
          typeof msg.source !== "string" ||
          msg.source.length > 100_000
        ) {
          return;
        }
        mermaidCoordinator.request(msg.id, msg.source, mermaidThemeRef.current);
        return;
      }
      if (msg.type === "valet-artifact:pick") {
        const rect = asRect(msg.rect);
        if (typeof msg.vdid !== "string" || !VDID_RE.test(msg.vdid) || !rect) return;
        const label = typeof msg.label === "string" ? msg.label.slice(0, 80) : "";
        onPickRef.current?.({ vdid: msg.vdid, rect, label });
        return;
      }
      if (msg.type === "valet-artifact:rects") {
        if (typeof msg.rects !== "object" || msg.rects === null) return;
        const rects: Record<string, ArtifactAnchorRect> = {};
        for (const [vdid, raw] of Object.entries(msg.rects as Record<string, unknown>)) {
          if (!VDID_RE.test(vdid)) continue;
          const rect = asRect(raw);
          if (rect) rects[vdid] = rect;
        }
        onRectsRef.current?.(rects);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    pickingRef.current = picking;
    if (readyRef.current) post({ type: "valet-artifact:mode", picking });
  }, [picking]);

  const anchorsKey = (anchors ?? []).join(",");
  useEffect(() => {
    anchorsRef.current = anchors;
    if (readyRef.current) post({ type: "valet-artifact:anchors", vdids: anchors ?? [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- anchorsKey is the value identity of `anchors`.
  }, [anchorsKey]);

  useEffect(() => {
    // `themeRef.current` is already current — the render-time write above
    // runs on every render, including this one. Only the ready-gated
    // restamp belongs here.
    if (readyRef.current) {
      post({ type: "valet-artifact:theme", theme: theme ?? null });
    }
  }, [theme, mermaidTheme]);

  return (
    <iframe
      ref={frameRef}
      title={title}
      srcDoc={srcDoc}
      sandbox={ARTIFACT_FRAME_SANDBOX}
      className={className}
    />
  );
}
