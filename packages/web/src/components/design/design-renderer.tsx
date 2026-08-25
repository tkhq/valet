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
  .vd-body { display: block; min-height: 100%; }
  /* The canvas owns slide navigation. Reveal-style decks ship sections as
     position:absolute + opacity:0 and rely on a script (stripped) to add
     an .active class — without this override 5 of 6 slides render as
     blank rectangles while the markup looks fine to every tool. */
  section.vd-active {
    display: block !important;
    opacity: 1 !important;
    visibility: visible !important;
    transform: none !important;
    position: relative !important;
  }
  .vd-hover-target { outline: 2px dashed #3b82f6; outline-offset: 2px; }
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

export interface DesignRenderHealth {
  totalSlides: number;
  /** 0-based indexes of top-level sections the artifact's OWN styles hide
   * (display:none / visibility:hidden / opacity≈0 / zero-height) —
   * measured before the canvas applies its slide toggling. */
  hiddenSlides: number[];
  /** 0-based indexes of sections whose content is taller than the slide
   * box (scrollHeight > clientHeight) — the content gets clipped. */
  overflowingSlides: number[];
  /** 0-based indexes of sections whose content occupies less than half
   * the stage height — top-crammed slides with dead space below. */
  sparseSlides: number[];
  /** `<script>` tags in the raw document; all of them are stripped. */
  scriptsStripped: number;
}

/**
 * Heartbeat period for render-health reports. The server keeps the report
 * in memory with a reportedAt timestamp — an api restart loses it, and the
 * agent-side reader treats reports older than ~10 minutes as expired. A
 * mounted canvas re-measures and re-posts at this period so its report
 * stays fresh across both.
 */
export const HEALTH_HEARTBEAT_MS = 60_000;

/** How long a deferred re-measure waits for running animations to finish
 * before it measures anyway — a looping animation must not block the
 * report forever. */
const ANIMATION_SETTLE_CAP_MS = 2_000;

/** FNV-1a 32-bit — a tiny stable hash for the measured verdict. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * Dedupe key for a health report: revision PLUS a hash of the measured
 * verdict. Two contradictory measurements of the same revision (pre- and
 * post-animation, fonts late) get different keys, so the second posts
 * instead of being swallowed by a revision-only key.
 */
export function healthReportKey(revision: string, health: DesignRenderHealth): string {
  const verdict = JSON.stringify([
    health.totalSlides,
    health.hiddenSlides,
    health.overflowingSlides,
    health.sparseSlides,
    health.scriptsStripped,
  ]);
  return `${revision}:${fnv1a(verdict)}`;
}

/**
 * Gate for posting health reports. Admits a post when the key changed OR
 * the last admitted post is older than maxAgeMs. The age clause is the
 * heartbeat path: without it, a once-per-key dedupe suppresses every
 * re-post after an api restart wipes the server-side report, and the
 * agent reads "no canvas has rendered this artifact" while the user
 * stares at a live canvas.
 */
export function createHealthPostGate(
  maxAgeMs: number = HEALTH_HEARTBEAT_MS,
): (key: string, now?: number) => boolean {
  let lastKey = "";
  let lastAt = Number.NEGATIVE_INFINITY;
  return (key, now = Date.now()) => {
    if (key === lastKey && now - lastAt < maxAgeMs) return false;
    lastKey = key;
    lastAt = now;
    return true;
  };
}

/**
 * Hidden-slide verdict for the health lint, from computed style + rect.
 * `display: none` is a hard hide (it cannot animate to visible). The soft
 * causes — `visibility: hidden`, near-zero opacity, near-zero rect height
 * — are exactly the pre-animation state of reveal-on-scroll decks, so
 * they only count as hidden when nothing is animating the element:
 * mid-flight elements are re-judged by the post-animation re-measure.
 */
export function isSectionHidden(s: {
  display: string;
  visibility: string;
  opacity: string;
  heightPx: number;
  hasLiveAnimation: boolean;
}): boolean {
  if (s.display === "none") return true;
  const soft =
    s.visibility === "hidden" || parseFloat(s.opacity) < 0.05 || s.heightPx < 8;
  return soft && !s.hasLiveAnimation;
}

/** Running or play-pending — the states that mean "judgment is premature". */
function isLiveAnimation(a: Animation): boolean {
  return a.playState === "running" || a.pending;
}

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
  /** Called after each mount with what ACTUALLY renders — the feedback an
   * agent cannot get from markup alone. Only the main canvas passes this;
   * thumbnails do not. */
  onRenderHealth?: (health: DesignRenderHealth) => void;
  className?: string;
}

/**
 * Rewrite document-level selectors in an artifact stylesheet to target the
 * `.vd-body` mount wrapper. Textual heuristic, deliberately narrow: only
 * `:root`, `html`, and `body` tokens in selector position. A descendant
 * combination like `html body` collapses to a doubled class that no longer
 * matches — acceptable for v1, and rarer than the plain `body {` /
 * `:root {` rules every generated artifact carries.
 */
function remapDocumentSelectors(css: string): string {
  return css
    .replace(/:root\b/g, ".vd-body")
    .replace(/(^|[\s,{}])(?:html|body)(?![\w-])/g, "$1.vd-body");
}

/**
 * The fixed logical stage for slides (the Claude Design model: slides are
 * authored at 1920×1080 and the viewer scales to fit). A fixed stage makes
 * layout deterministic — overflow is measured against a known height, and
 * a slide renders identically at every viewport size.
 */
export const STAGE_W = 1920;
export const STAGE_H = 1080;

function applyStageSizing(sections: HTMLElement[]): void {
  for (const s of sections) {
    s.style.setProperty("width", `${STAGE_W}px`);
    s.style.setProperty("height", `${STAGE_H}px`);
    s.style.setProperty("box-sizing", "border-box");
    // Visually clip what overflows the stage — that IS what export and
    // present show; the health report names the overflowing slides.
    s.style.setProperty("overflow", "hidden");
  }
}

/** Outermost `<section>`s at any depth — agents often wrap slides in a
 * container div, and a strict children-only read blanked the slide strip
 * and active-slide toggling for those documents. */
function topLevelSections(shadow: ShadowRoot): HTMLElement[] {
  return Array.from(shadow.querySelectorAll("section")).filter(
    (el): el is HTMLElement => !(el.parentElement?.closest("section")),
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
  onRenderHealth,
  className,
}: DesignRendererProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  const healthRef = useRef(onRenderHealth);
  healthRef.current = onRenderHealth;
  // Latest mount's measure function, for the heartbeat interval. The mount
  // effect replaces it on every content change; a no-op before first mount.
  const measureRef = useRef<() => void>(() => {});
  const slidesModeRef = useRef(activeSlideIndex !== undefined);
  slidesModeRef.current = activeSlideIndex !== undefined;
  // Fit scale for the fixed stage (slides mode): stage width → container
  // width, recomputed on container resize.
  const [fitScale, setFitScale] = useState(1);
  const frameRef = useRef<HTMLDivElement>(null);
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

  // Comment-mode hover highlight: outline the element a click would anchor
  // to, so the user sees the comment target (heading vs whole slide) BEFORE
  // committing — a click a few pixels off the text otherwise anchors to the
  // enclosing section with no feedback.
  useEffect(() => {
    const shadow = shadowRef.current;
    if (!shadow || !commentMode) return;
    let marked: Element | null = null;
    const clear = () => {
      marked?.classList.remove("vd-hover-target");
      marked = null;
    };
    const onOver = (e: Event) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const el = target.closest("[data-vdid]");
      if (el === marked) return;
      clear();
      if (el) {
        el.classList.add("vd-hover-target");
        marked = el;
      }
    };
    shadow.addEventListener("mouseover", onOver);
    return () => {
      shadow.removeEventListener("mouseover", onOver);
      clear();
    };
  }, [commentMode]);

  // Sanitize + mount whenever the artifact bytes change.
  useEffect(() => {
    const shadow = shadowRef.current;
    if (!shadow || !version.ok) return;
    // Fragment parsing flattens the sanitized document's html/head/body
    // wrappers; its <style> blocks and body content land in order. The
    // content mounts under a `.vd-body` wrapper, and document-level
    // selectors in the artifact's stylesheets (`:root`, `html`, `body` —
    // none of which exist or match inside a shadow root) are remapped onto
    // it: artifacts routinely put their page background, base typography,
    // and custom-property definitions there, and without the remap a
    // "dark theme" deck renders washed-out on white.
    shadow.innerHTML = `<style>${OVERLAY_CSS}</style><div class="vd-body">${sanitizeDesignHtml(content)}</div>`;
    for (const styleEl of Array.from(shadow.querySelectorAll("style"))) {
      styleEl.textContent = remapDocumentSelectors(styleEl.textContent ?? "");
    }
    // Slides mode: put every slide on the fixed stage BEFORE measuring, so
    // the overflow lint measures against the same box the viewer shows.
    if (slidesModeRef.current) {
      applyStageSizing(topLevelSections(shadow));
    }
    let cancelled = false;
    const timers: number[] = [];
    const schedule = (fn: () => void, ms: number) => {
      timers.push(window.setTimeout(fn, ms));
    };
    // Animation probes. jsdom (tests) has no getAnimations; treat that as
    // "nothing animating". `subtree: true` covers entrance animations on a
    // slide's children; the ancestor walk covers a wrapper fading the whole
    // deck in. The walk ends at `.vd-body` (its parent is the shadow root).
    const sectionAnimated = (el: HTMLElement): boolean => {
      if (typeof el.getAnimations !== "function") return false;
      try {
        if (el.getAnimations({ subtree: true }).some(isLiveAnimation)) return true;
        for (let p = el.parentElement; p; p = p.parentElement) {
          if (p.getAnimations().some(isLiveAnimation)) return true;
        }
      } catch {
        return false;
      }
      return false;
    };
    const liveCanvasAnimations = (): Animation[] => {
      const body = shadow.querySelector(".vd-body");
      if (!body || typeof body.getAnimations !== "function") return [];
      try {
        return body.getAnimations({ subtree: true }).filter(isLiveAnimation);
      } catch {
        return [];
      }
    };
    // Measure artifact-intrinsic visibility HERE, before the slide-toggle
    // effect adds its own inline display/vd-active overrides — then once
    // more after fonts load and images decode (a slide that is one big
    // image measures empty at mount and would falsely report sparse).
    const measureHealth = () => {
      if (cancelled || !healthRef.current) return;
      const sections = topLevelSections(shadow);
      // The slide-toggle effect hides every non-active slide with an inline
      // display:none (tagged data-vd-toggled-off). The post-load re-measures
      // run after that effect, so lift OUR overrides for the measurement or
      // every deck reports slides 2..n hidden — a false positive that sends
      // the agent into rewrite loops. Artifact-authored hiding stays visible.
      const restore: HTMLElement[] = [];
      for (const el of sections) {
        if (el.dataset.vdToggledOff === "1") {
          el.style.removeProperty("display");
          restore.push(el);
        }
      }
      const hiddenSlides: number[] = [];
      const overflowingSlides: number[] = [];
      const sparseSlides: number[] = [];
      sections.forEach((el, i) => {
        const cs = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (
          isSectionHidden({
            display: cs.display,
            visibility: cs.visibility,
            opacity: cs.opacity,
            heightPx: rect.height,
            hasLiveAnimation: sectionAnimated(el),
          })
        ) {
          hiddenSlides.push(i);
          return;
        }
        // Clipping lint: content taller than the slide box. The 12px slack
        // forgives rounding; a real overflow is tens to hundreds of px.
        if (el.scrollHeight > el.clientHeight + 12) {
          overflowingSlides.push(i);
          return;
        }
        // Underfill lint (stage mode): content pinned to the top with dead
        // space below — the top-cram failure the craft guide forbids.
        // Centered content extends past the midline and passes.
        if (slidesModeRef.current && el.children.length > 0 && rect.height > 0) {
          let maxBottom = rect.top;
          for (const child of Array.from(el.children)) {
            const r = child.getBoundingClientRect();
            if (r.bottom > maxBottom) maxBottom = r.bottom;
          }
          // Normalize by the section's own rendered height, not STAGE_H:
          // post-load re-measures run under the fit-scale transform, where
          // every rect is scaled down and a STAGE_H denominator flags every
          // slide as sparse.
          if ((maxBottom - rect.top) / rect.height < 0.5) sparseSlides.push(i);
        }
      });
      for (const el of restore) el.style.setProperty("display", "none");
      healthRef.current?.({
        totalSlides: sections.length,
        hiddenSlides,
        overflowingSlides,
        sparseSlides,
        scriptsStripped: (content.match(/<script\b/gi) ?? []).length,
      });
    };
    // Deferred re-measure: judging mid-animation produces false hidden and
    // sparse verdicts, so wait for running animations to finish first — with
    // a hard cap, because a looping animation never finishes and must not
    // block reporting forever.
    const measureWhenSettled = (capMs: number) => {
      if (cancelled) return;
      const anims = liveCanvasAnimations();
      if (anims.length === 0) {
        measureHealth();
        return;
      }
      let fired = false;
      const go = () => {
        if (fired || cancelled) return;
        fired = true;
        measureHealth();
      };
      schedule(go, capMs);
      // `finished` of an infinite animation never settles; the cap fires.
      void Promise.allSettled(anims.map((a) => a.finished)).then(go);
    };
    measureHealth();
    measureRef.current = measureHealth;
    // Post-load re-measure: fonts.ready settles webfont reflow; the timer
    // catches image decode. The canvas dedupes identical reports.
    void document.fonts?.ready.then(() => measureWhenSettled(ANIMATION_SETTLE_CAP_MS)).catch(() => {});
    schedule(() => measureWhenSettled(ANIMATION_SETTLE_CAP_MS), 1200);
    setDomVersion((v) => v + 1);
    return () => {
      cancelled = true;
      for (const id of timers) window.clearTimeout(id);
    };
    // `version.ok` is derived from `content`; content is the real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  // Health heartbeat: re-measure (and so re-deliver a report) every 60s
  // while the canvas is mounted. See HEALTH_HEARTBEAT_MS for why a
  // once-per-key post is not enough. Cleared on unmount; a no-op when the
  // caller passes no onRenderHealth (thumbnails).
  useEffect(() => {
    const id = window.setInterval(() => measureRef.current(), HEALTH_HEARTBEAT_MS);
    return () => window.clearInterval(id);
  }, []);

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

  // Slides: show ONLY the active top-level <section>, and force it visible
  // even when the artifact's own stylesheet hides sections by default.
  useEffect(() => {
    const shadow = shadowRef.current;
    if (!shadow) return;
    const sections = topLevelSections(shadow);
    if (activeSlideIndex === undefined) {
      for (const s of sections) {
        s.style.removeProperty("display");
        s.classList.remove("vd-active");
        delete s.dataset.vdToggledOff;
      }
      return;
    }
    applyStageSizing(sections);
    sections.forEach((s, i) => {
      if (i === activeSlideIndex) {
        s.style.removeProperty("display");
        s.classList.add("vd-active");
        delete s.dataset.vdToggledOff;
      } else {
        s.style.setProperty("display", "none");
        // Tag it as OUR hide so measureHealth can tell the toggle's
        // display:none apart from artifact-authored hiding.
        s.dataset.vdToggledOff = "1";
        s.classList.remove("vd-active");
      }
    });
  }, [activeSlideIndex, domVersion]);

  // Fit the stage to the container (slides mode only).
  useEffect(() => {
    if (activeSlideIndex === undefined) return;
    const frame = frameRef.current;
    if (!frame) return;
    const update = () => {
      const w = frame.clientWidth;
      if (w > 0) setFitScale(w / STAGE_W);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(frame);
    return () => ro.disconnect();
  }, [activeSlideIndex === undefined]);

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

  const slidesMode = activeSlideIndex !== undefined;
  const stageScale = fitScale * zoom;
  return (
    <div className={className} ref={frameRef}>
      <div
        style={slidesMode ? { height: STAGE_H * stageScale } : undefined}
      >
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
            ...(slidesMode
              ? {
                  width: STAGE_W,
                  transform: `scale(${stageScale})`,
                  transformOrigin: "top left",
                }
              : {
                  transform: zoom === 1 ? undefined : `scale(${zoom})`,
                  transformOrigin: "top center",
                }),
            cursor: commentMode ? "crosshair" : undefined,
          }}
        />
      </div>
    </div>
  );
}
