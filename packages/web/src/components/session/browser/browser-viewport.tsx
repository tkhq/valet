import { useEffect, useRef, useState, type PointerEvent } from "react";
import { browserPointerCursor, type BrowserHumanInput, type BrowserPointerCursor } from "@valet/shared";
import type { BrowserFrame } from "~/api/browser";
import { browserKey, browserPoint, browserWheel } from "./input";
import { BrowserInputQueue } from "./input-queue";

export function BrowserViewport({
  frame,
  canControl,
  send,
  onError,
}: {
  frame: BrowserFrame;
  canControl: boolean;
  send: (input: BrowserHumanInput) => Promise<BrowserPointerCursor | void>;
  onError: (message: string) => void;
}) {
  const surface = useRef<HTMLTextAreaElement>(null);
  const [loadedDocument, setLoadedDocument] = useState<string | null>(null);
  const callbacks = useRef({ send, onError });
  callbacks.current = { send, onError };
  const queue = useRef<BrowserInputQueue | null>(null);
  const [cursor, setCursor] = useState<BrowserPointerCursor>("default");
  const pointerVisit = useRef(0);
  const pointerPoint = useRef<{ x: number; y: number } | null>(null);
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
    return () => {
      active = false;
      next.dispose();
    };
  }, [target, canControl]);

  useEffect(() => {
    const element = surface.current;
    if (!ready || !element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      queue.current?.add(
        browserWheel(
          event.deltaX,
          event.deltaY,
          event.deltaMode,
          frame.viewport.height,
        ),
      );
    };
    // React's delegated wheel listener is passive and cannot stop local scrolling.
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [ready, frame.viewport.height]);

  function input(value: BrowserHumanInput) {
    if (ready) queue.current?.add(value);
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
    <div className="relative min-h-48 flex-1 overflow-hidden bg-ink-wash">
      <img
        key={target}
        src={frame.url}
        alt="Browser page"
        draggable={false}
        className="absolute inset-0 h-full w-full select-none object-contain"
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
        className="absolute inset-0 h-full w-full cursor-default resize-none border-0 bg-transparent text-transparent caret-transparent outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-moss"
        onPointerDown={(event) => pointer(event, "down")}
        onPointerMove={(event) => pointer(event, "move")}
        onPointerUp={(event) => pointer(event, "up")}
        style={{ cursor: ready ? cursor : "default" }}
        onPointerLeave={leavePointer}
        onPointerCancel={() => { releaseHeld(); leavePointer(); }}
        onContextMenu={(event) => {
          if (ready) event.preventDefault();
        }}
        onBlur={releaseHeld}
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
  );
}
