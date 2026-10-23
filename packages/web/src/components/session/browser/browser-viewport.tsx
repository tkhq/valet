import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { Keyboard, Minus, Plus, Move } from "lucide-react";
import { Button } from "~/components/primitives";
import { browserPointerCursor, type BrowserHumanInput, type BrowserPointerCursor } from "@valet/shared";
import type { BrowserFrame } from "~/api/browser";
import { browserKey, browserPoint, browserWheel } from "./input";
import { BrowserInputQueue } from "./input-queue";
import { BrowserPageImage } from "./browser-page-image";

export interface BrowserReaderState {
  zoom: number;
  pan: boolean;
  scrollLeft: number;
  scrollTop: number;
}

export function BrowserViewport({
  frame,
  mobile = false,
  initialReaderState,
  onReaderStateChange,
  canControl,
  controlEpoch,
  showAgentCursor = true,
  send,
  onError,
}: {
  frame: BrowserFrame;
  mobile?: boolean;
  initialReaderState?: BrowserReaderState;
  onReaderStateChange?: (state: BrowserReaderState) => void;
  canControl: boolean;
  controlEpoch?: string;
  showAgentCursor?: boolean;
  send: (input: BrowserHumanInput) => Promise<BrowserPointerCursor | void>;
  onError: (message: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(initialReaderState?.zoom ?? 1);
  const [pan, setPan] = useState(initialReaderState?.pan ?? true);
  const savedReaderState = useRef(initialReaderState);
  const priorZoom = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (mobile && element) {
      if (priorZoom.current === null) {
        element.scrollLeft = savedReaderState.current?.scrollLeft ?? Math.max(0, (frame.viewport.width * zoom - element.clientWidth) / 2 - element.clientWidth / 4);
        element.scrollTop = savedReaderState.current?.scrollTop ?? 0;
      } else {
        const ratio = zoom / priorZoom.current;
        element.scrollLeft = (element.scrollLeft + element.clientWidth / 2) * ratio - element.clientWidth / 2;
        element.scrollTop = (element.scrollTop + element.clientHeight / 2) * ratio - element.clientHeight / 2;
      }
      priorZoom.current = zoom;
    }
  }, [mobile, zoom, frame.viewport.width]);
  function saveReaderState() {
    const element = scroller.current;
    if (mobile && element) onReaderStateChange?.({
      zoom, pan, scrollLeft: element.scrollLeft, scrollTop: element.scrollTop,
    });
  }
  useLayoutEffect(() => { saveReaderState(); }, [mobile, zoom, pan, onReaderStateChange]);
  const surface = useRef<HTMLTextAreaElement>(null);
  const [loadedDocument, setLoadedDocument] = useState<string | null>(null);
  const [suppressedCursor, setSuppressedCursor] = useState<{ target: string; sequence: number } | null>(null);
  const callbacks = useRef({ send, onError });
  callbacks.current = { send, onError };
  const queue = useRef<BrowserInputQueue | null>(null);
  const [cursor, setCursor] = useState<BrowserPointerCursor>("default");
  const pointerVisit = useRef(0);
  const pointerPoint = useRef<{ x: number; y: number } | null>(null);
  const touch = useRef<{
    id: number;
    x: number;
    y: number;
    startX: number;
    startY: number;
    scrolling: boolean;
  } | null>(null);
  const composing = useRef(false);
  const typedKey = useRef(false);
  const composedText = useRef<string | null>(null);
  const heldKeys = useRef(new Set<string>());
  const heldPointer = useRef<{
    x: number;
    y: number;
    button: "left" | "middle" | "right";
  } | null>(null);
  const target = `${frame.runtimeId}:${frame.tabId}:${frame.documentId}:${frame.viewport.width}:${frame.viewport.height}`;
  const ready = canControl && loadedDocument === target;

  useEffect(() => {
    let active = true;
    setCursor("default");
    pointerPoint.current = null;
    pointerVisit.current++;
    const next = new BrowserInputQueue(
      async (input) => {
        const visit = pointerVisit.current;
        const feedback = await callbacks.current.send(input);
        const point = pointerPoint.current;
        if (active && feedback && visit === pointerVisit.current && point &&
            (input.type === "pointer" || input.type === "move" || input.type === "click") &&
            point.x === input.x && point.y === input.y)
          setCursor(browserPointerCursor(feedback));
      },
      (error) => callbacks.current.onError(error),
    );
    queue.current = next;
    heldKeys.current.clear();
    heldPointer.current = null;
    touch.current = null;
    composing.current = false;
    typedKey.current = false;
    composedText.current = null;
    return () => {
      active = false;
      next.dispose();
    };
  }, [target, canControl, controlEpoch]);

  useEffect(() => {
    const element = surface.current;
    if (!ready || !element) return;
    const wheel = (event: WheelEvent) => {
      if (mobile && pan) return;
      event.preventDefault();
      setSuppressedCursor({ target, sequence: frame.agentCursor?.sequence ?? -1 });
      queue.current?.add(
        browserWheel(
          event.deltaX,
          event.deltaY,
          event.deltaMode,
          frame.viewport.height,
        ),
      );
    };
    const beforeInput = (event: InputEvent) => {
      if (composing.current || event.isComposing) return;
      const key = event.inputType === "deleteContentBackward" ? "Backspace"
        : event.inputType === "deleteContentForward" ? "Delete"
          : ["insertLineBreak", "insertParagraph"].includes(event.inputType) ? "Enter" : null;
      if (!key) return;
      event.preventDefault();
      if (!heldKeys.current.has(key)) input({ type: "key", key, phase: "press" });
    };
    element.addEventListener("beforeinput", beforeInput);
    // React's delegated wheel listener is passive and cannot stop local scrolling.
    element.addEventListener("wheel", wheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("beforeinput", beforeInput);
    };
  }, [ready, frame.viewport.height, target, frame.agentCursor?.sequence, mobile, pan]);

  function input(value: BrowserHumanInput) {
    if (ready) {
      setSuppressedCursor({ target, sequence: frame.agentCursor?.sequence ?? -1 });
      queue.current?.add(value);
    }
  }
  function releaseHeld() {
    for (const key of heldKeys.current)
      input({ type: "key", key, phase: "up" });
    heldKeys.current.clear();
    if (heldPointer.current)
      input({ type: "pointer", phase: "up", ...heldPointer.current });
    heldPointer.current = null;
  }
  function leavePointer() {
    if (pointerPoint.current) pointerVisit.current++;
    pointerPoint.current = null;
    setCursor("default");
  }
  function pointer(
    event: PointerEvent<HTMLTextAreaElement>,
    phase: "down" | "up" | "move",
  ) {
    if (!ready) return;
    if (mobile && event.pointerType === "touch") {
      event.preventDefault();
      if (phase === "down") {
        const point = browserPoint(event.clientX, event.clientY,
          event.currentTarget.getBoundingClientRect(), frame.viewport);
        if (touch.current || !point) return;
        touch.current = {
          id: event.pointerId, x: event.clientX, y: event.clientY,
          startX: event.clientX, startY: event.clientY, scrolling: false,
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        return;
      }
      const gesture = touch.current;
      if (!gesture || gesture.id !== event.pointerId) return;
      if (phase === "move") {
        if (pan) {
          if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) >= 8) gesture.scrolling = true;
          return;
        }
        const bounds = event.currentTarget.getBoundingClientRect();
        const scale = Math.min(
          bounds.width / frame.viewport.width, bounds.height / frame.viewport.height,
        );
        if (!gesture.scrolling &&
            Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < 8) return;
        if (!gesture.scrolling) {
          const point = browserPoint(gesture.startX, gesture.startY, bounds, frame.viewport);
          if (point) input({ type: "move", ...point });
          gesture.scrolling = true;
        }
        if (scale > 0) input({
          type: "wheel", deltaX: (gesture.x - event.clientX) / scale,
          deltaY: (gesture.y - event.clientY) / scale,
        });
        gesture.x = event.clientX;
        gesture.y = event.clientY;
        return;
      }
      touch.current = null;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (!gesture.scrolling) {
        const point = browserPoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), frame.viewport);
        if (point) input({ type: "click", ...point, button: "left" });
      }
      return;
    }
    const point = browserPoint(
      event.clientX,
      event.clientY,
      event.currentTarget.getBoundingClientRect(),
      frame.viewport,
    );
    if (!point) {
      leavePointer();
      if (phase === "up") releaseHeld();
      return;
    }
    pointerPoint.current = point;
    const button =
      event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";
    if (phase === "down") {
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      heldPointer.current = { ...point, button };
    }
    if (phase === "move" && heldPointer.current)
      heldPointer.current = { ...heldPointer.current, ...point };
    input({
      type: "pointer",
      phase,
      ...point,
      ...(phase === "move" ? {} : { button }),
    });
    if (phase === "up") {
      heldPointer.current = null;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-ink-wash">
    <div ref={scroller} onScroll={saveReaderState} className={mobile ? "relative min-h-0 flex-1 overflow-auto" : "relative min-h-48 flex-1 overflow-hidden"}>
    <div aria-label="Remote page canvas" className={mobile ? "relative" : "absolute inset-0"}
      style={mobile ? { width: frame.viewport.width * zoom, height: frame.viewport.height * zoom } : undefined}>
      <BrowserPageImage
        frame={frame}
        showAgentCursor={showAgentCursor}
        alt="Browser page"
        suppressedSequence={suppressedCursor?.target === target ? suppressedCursor.sequence : undefined}
        onLoad={() => setLoadedDocument(target)}
        onError={() =>
          onError("The browser image could not load. Retry the browser view.")
        }
      />
      <textarea
        ref={surface}
        aria-label="Browser page input"
        aria-description={
          ready
            ? "Keyboard and pointer input go to the remote page. Press Escape and then Tab to leave this area."
            : "Wait for the current page image or check browser input status."
        }
        readOnly={!ready}
        tabIndex={ready ? 0 : -1}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        className="absolute inset-0 h-full w-full cursor-default resize-none border-0 bg-transparent text-transparent caret-transparent outline-none"
        onPointerDown={(event) => pointer(event, "down")}
        onPointerMove={(event) => pointer(event, "move")}
        onPointerUp={(event) => pointer(event, "up")}
        style={{ cursor: ready ? cursor : "default", touchAction: mobile && pan ? "pan-x pan-y" : "none", fontSize: 16 }}
        onPointerLeave={leavePointer}
        onPointerCancel={() => { touch.current = null; releaseHeld(); leavePointer(); }}
        onContextMenu={(event) => {
          if (ready) event.preventDefault();
        }}
        onBlur={() => { touch.current = null; releaseHeld(); }}
        onKeyDown={(event) => {
          if (!ready) return;
          const key = browserKey({
            key: event.key,
            isComposing: composing.current || event.nativeEvent.isComposing,
          });
          if (!key) return;
          // Only the explicit paste event transfers the local clipboard text.
          if (
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === "v"
          )
            return;
          // Escape exits capture so users can reach the controls with Tab.
          if (key === "Escape") {
            input({ type: "key", key, phase: "press" });
            event.currentTarget.blur();
            return;
          }
          composedText.current = null;
          typedKey.current = event.key.length === 1;
          if (
            event.key.length !== 1 ||
            event.ctrlKey ||
            event.metaKey ||
            event.altKey
          ) {
            event.preventDefault();
          }
          heldKeys.current.add(key);
          input({ type: "key", key, phase: "down" });
        }}
        onKeyUp={(event) => {
          const key = browserKey({
            key: event.key,
            isComposing: composing.current || event.nativeEvent.isComposing,
          });
          if (key && heldKeys.current.delete(key))
            input({ type: "key", key, phase: "up" });
        }}
        onCompositionStart={() => {
          composing.current = true;
          typedKey.current = false;
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          composedText.current = event.data;
          if (event.data) input({ type: "text", text: event.data });
          event.currentTarget.value = "";
        }}
        onChange={(event) => {
          if (composing.current) return;
          const text = event.currentTarget.value;
          if (!typedKey.current && text && text !== composedText.current)
            input({ type: "text", text });
          typedKey.current = false;
          composedText.current = null;
          event.currentTarget.value = "";
        }}
        onPaste={(event) => {
          if (!ready) return;
          event.preventDefault();
          const text = event.clipboardData.getData("text/plain");
          if (text) input({ type: "text", text });
        }}
      />
    </div>
    </div>
    <div className={mobile ? "grid shrink-0 grid-cols-[2.75rem_3.5rem_2.75rem_1fr_2.75rem] items-center gap-1 border-t border-line bg-paper px-2" : "hidden"}>
      <Button variant="ghost" className="w-11 shrink-0 px-0" aria-label="Zoom out" disabled={zoom <= 0.25} onClick={() => setZoom(Math.max(0.25, zoom - 0.25))}><Minus className="h-4 w-4" /></Button>
      <Button variant="ghost" aria-label={zoom < 1 ? "Actual size" : "Fit page"} className="w-14 px-0 tabular-nums" onClick={() => setZoom(zoom < 1 ? 1 : scroller.current ? Math.min(1, scroller.current.clientWidth / frame.viewport.width) : 1)}>{Math.round(zoom * 100)}%</Button>
      <Button variant="ghost" className="w-11 shrink-0 px-0" aria-label="Zoom in" disabled={zoom >= 2} onClick={() => setZoom(Math.min(2, zoom + 0.25))}><Plus className="h-4 w-4" /></Button>
      <Button variant={!pan ? "secondary" : "ghost"} aria-label="Page scroll" className="min-w-0 px-1" aria-pressed={!pan} onClick={() => setPan(!pan)}><Move className="h-4 w-4" aria-hidden />Scroll</Button>
      <Button variant="ghost" className="w-11 shrink-0 px-0"
        aria-label="Show browser keyboard" disabled={!ready}
        onClick={() => surface.current?.focus()}>
        <Keyboard className="h-5 w-5" aria-hidden />
      </Button>
    </div>
    {mobile && <p className="shrink-0 bg-paper px-3 pb-1 text-center text-[11px] text-muted">{pan ? "Drag to look around · Tap to interact" : "Swipe to scroll the page · Tap to interact"}</p>}
    </div>
  );
}
