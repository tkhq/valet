/**
 * DesignRenderer — mounts sanitized `.dc.html` bytes in a shadow root
 * (Valet Design spec §Ports, Resolved Decision 1). The shadow root keeps
 * the artifact's `<style>` blocks from bleeding into the app and the app's
 * styles from restyling the artifact; DOMPurify (see `./sanitize.ts`) is
 * the security control.
 *
 * Slides: `activeSlideIndex` shows ONLY the Nth top-level `<section>` and
 * hides the rest (display toggling, not scrolling — one visible slide is
 * the presentation model, and it needs no scroll-position bookkeeping).
 */
import { useEffect, useRef, useState } from "react";
import { checkDesignVersion, sanitizeDesignHtml } from "./sanitize";

/**
 * Styles injected beside the artifact's own, inside the shadow root.
 * `data-vd-comments` is client-local (set by the comment-badge effect,
 * never part of the artifact): elements with unresolved comments get an
 * outline plus a count badge.
 */
const OVERLAY_CSS = `
  [data-vd-comments] { position: relative; outline: 2px solid #f59e0b; outline-offset: 2px; }
  [data-vd-comments]::after {
    content: attr(data-vd-comments);
    position: absolute; top: -0.65rem; right: -0.65rem;
    min-width: 1.15rem; height: 1.15rem; padding: 0 0.3rem;
    border-radius: 9999px; background: #f59e0b; color: #fff;
    font: 700 0.7rem/1.15rem system-ui, sans-serif; text-align: center;
    z-index: 10;
  }
`;

export interface DesignRendererProps {
  /** The full `.dc.html` document (unsanitized — sanitized here). */
  content: string;
  /** Design-system tokens; keys carry the leading `--`. Applied as CSS
   * custom properties on the host, which inherit into the shadow tree. */
  tokens: Record<string, string>;
  /** For `template=slides`: show only this top-level `<section>`. */
  activeSlideIndex?: number;
  /** CSS scale factor. 1 = natural size. */
  zoom?: number;
  /** Unresolved-comment counts by vdid, rendered as badge overlays. */
  commentCounts?: Record<string, number>;
  /** Click on an element inside the canvas, resolved to the nearest
   * ancestor carrying `data-vdid`. Clicks elsewhere are not reported. */
  onElementClick?: (vdid: string) => void;
  /** Renders a crosshair cursor while comment mode is armed. */
  commentMode?: boolean;
  className?: string;
}

function topLevelSections(shadow: ShadowRoot): HTMLElement[] {
  return Array.from(shadow.children).filter(
    (el): el is HTMLElement => el.tagName === "SECTION",
  );
}

export function DesignRenderer({
  content,
  tokens,
  activeSlideIndex,
  zoom = 1,
  commentCounts,
  onElementClick,
  commentMode,
  className,
}: DesignRendererProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  // Bumped after every innerHTML replacement so the attribute-mutating
  // effects (slides, badges) re-run against the fresh DOM.
  const [domVersion, setDomVersion] = useState(0);
  // The click listener is attached once to the shadow root (it survives
  // innerHTML replacement); the handler reads the latest callback here.
  const clickRef = useRef(onElementClick);
  clickRef.current = onElementClick;

  const version = checkDesignVersion(content);

  // Create the shadow root and its click listener once per host element.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // StrictMode remounts reuse the already-attached root — attachShadow on
    // a host that has one throws.
    shadowRef.current = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const shadow = shadowRef.current;
    const onClick = (e: Event) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const el = target.closest("[data-vdid]");
      const vdid = el?.getAttribute("data-vdid");
      if (vdid) clickRef.current?.(vdid);
    };
    shadow.addEventListener("click", onClick);
    return () => shadow.removeEventListener("click", onClick);
  }, []);

  // Sanitize + mount whenever the artifact bytes change.
  useEffect(() => {
    const shadow = shadowRef.current;
    if (!shadow || !version.ok) return;
    // Fragment parsing flattens the sanitized document's html/head/body
    // wrappers; its <style> blocks and body content land in order.
    shadow.innerHTML = `<style>${OVERLAY_CSS}</style>${sanitizeDesignHtml(content)}`;
    setDomVersion((v) => v + 1);
    // `version.ok` is derived from `content`; content is the real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  // Design tokens as CSS custom properties on the host — they inherit
  // through the shadow boundary, so the artifact's `var(--…)` reads them.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const applied: string[] = [];
    for (const [name, value] of Object.entries(tokens)) {
      if (!name.startsWith("--")) continue;
      host.style.setProperty(name, value);
      applied.push(name);
    }
    return () => {
      for (const name of applied) host.style.removeProperty(name);
    };
  }, [tokens]);

  // Slides: show only the active top-level <section>.
  useEffect(() => {
    const shadow = shadowRef.current;
    if (!shadow) return;
    const sections = topLevelSections(shadow);
    if (activeSlideIndex === undefined) {
      for (const s of sections) s.style.removeProperty("display");
      return;
    }
    sections.forEach((s, i) => {
      if (i === activeSlideIndex) s.style.removeProperty("display");
      else s.style.setProperty("display", "none");
    });
  }, [activeSlideIndex, domVersion]);

  // Unresolved-comment badges.
  useEffect(() => {
    const shadow = shadowRef.current;
    if (!shadow) return;
    for (const el of Array.from(shadow.querySelectorAll("[data-vd-comments]"))) {
      el.removeAttribute("data-vd-comments");
    }
    if (!commentCounts) return;
    for (const [vdid, count] of Object.entries(commentCounts)) {
      if (count <= 0) continue;
      shadow
        .querySelector(`[data-vdid="${CSS.escape(vdid)}"]`)
        ?.setAttribute("data-vd-comments", String(count));
    }
  }, [commentCounts, domVersion]);

  if (!version.ok) {
    return (
      <div className={className}>
        <div className="p-6 text-sm text-muted">
          This document uses design format v{version.version}, which this app
          cannot render. Update the app, then reload.
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      <div
        ref={hostRef}
        style={{
          // Containment is load-bearing, not cosmetic: artifacts may use
          // `position: fixed` / viewport units, and fixed descendants of a
          // shadow root otherwise position AND hit-test against the app
          // viewport — an artifact overlay silently swallows clicks on the
          // history panel and chat input. `contain: paint` makes this host
          // the containing block for fixed descendants and clips painting
          // to the canvas box.
          contain: "paint",
          transform: zoom === 1 ? undefined : `scale(${zoom})`,
          transformOrigin: "top center",
          cursor: commentMode ? "crosshair" : undefined,
        }}
      />
    </div>
  );
}
