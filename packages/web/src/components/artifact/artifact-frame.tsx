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
  const readyRef = useRef(false);
  // Live refs so the message listener never rebinds mid-load (rebinding can
  // drop the `ready` handshake and strand the bridge).
  const onPickRef = useRef(onPick);
  const onRectsRef = useRef(onRects);
  onPickRef.current = onPick;
  onRectsRef.current = onRects;
  const pickingRef = useRef(picking);
  const anchorsRef = useRef(anchors);
  // The mount-time theme is frozen into the srcDoc (below); a later flip
  // restamps via postMessage instead of reloading the frame, so script state
  // survives. This ref carries the CURRENT value for that restamp.
  const initialThemeRef = useRef(theme);
  const themeRef = useRef(theme);

  const srcDoc = useMemo(
    () =>
      buildArtifactDocument({
        title,
        content: rendered,
        icon,
        description,
        runtime: true,
        theme: initialThemeRef.current ?? undefined,
      }),
    [title, rendered, icon, description],
  );

  // A srcDoc change reloads the frame's document, so the bridge starts over.
  useEffect(() => {
    readyRef.current = false;
  }, [srcDoc]);

  const post = (message: unknown) => {
    // "*" is the only addressable target: an opaque origin has no name. The
    // payloads carry mode flags and vdids, nothing secret.
    frameRef.current?.contentWindow?.postMessage(message, "*");
  };

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
    themeRef.current = theme;
    if (readyRef.current) {
      post({ type: "valet-artifact:theme", theme: theme ?? null });
    }
  }, [theme]);

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
