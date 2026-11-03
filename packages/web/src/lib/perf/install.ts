import type { QueryClient } from "@tanstack/react-query";
import { flowForNavigation, interactionName, type FlowLocation } from "./flows";
import { PerfMonitor, type Measurement } from "./monitor";
import type { PerfMode } from "./flag";

/** The router events this module reads. Structural, so tests and the app's typed router both fit. */
export interface PerfRouter {
  subscribe(
    event: "onBeforeNavigate" | "onResolved",
    fn: (event: { fromLocation?: FlowLocation; toLocation: FlowLocation }) => void,
  ): () => void;
}

/** What the CI check and the console read: `window.__valetPerf`. */
export interface PerfHandle {
  entries(): Measurement[];
  clear(): void;
}

declare global {
  interface Window {
    __valetPerf?: PerfHandle;
  }
}

/** Runs `fn` after the next frame paints: a task queued from inside a frame callback runs after that frame. */
function afterPaint(fn: () => void): void {
  requestAnimationFrame(() => setTimeout(fn, 0));
}

/**
 * Starts measuring. Called once from `main.tsx` when `perfMode()` is on.
 * Every listener here is passive, and the monitor keeps a fixed-size buffer.
 */
export function installPerf(router: PerfRouter, queryClient: QueryClient, mode: Exclude<PerfMode, "off">): PerfMonitor {
  const monitor = new PerfMonitor({ now: () => performance.now(), afterPaint });

  const onPress = (event: Event) => {
    const key = event instanceof KeyboardEvent ? event.key : undefined;
    const press = interactionName(event.target, event.type, key);
    if (press) monitor.press(press.name, event.timeStamp, press.tagged);
  };
  window.addEventListener("click", onPress, { capture: true, passive: true });
  window.addEventListener("keydown", onPress, { capture: true, passive: true });

  // The browser's timing also counts input delay. It reports presses of 16 ms or more.
  if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("event")) {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === "click" || entry.name === "keydown") monitor.eventTiming(entry.startTime, entry.duration);
      }
    });
    // `durationThreshold` is missing from TypeScript's DOM types.
    const init: PerformanceObserverInit & { durationThreshold: number } = { type: "event", durationThreshold: 16 };
    observer.observe(init);
  }

  router.subscribe("onBeforeNavigate", () => monitor.navigationStart());
  // The router emits onResolved from a layout effect, once the destination has committed.
  router.subscribe("onResolved", (event) => monitor.navigationRendered(flowForNavigation(event.fromLocation, event.toLocation)));

  queryClient.getQueryCache().subscribe((event) => {
    if (event.type === "removed") {
      monitor.querySettled(event.query.queryHash);
      return;
    }
    if (event.type !== "updated") return;
    const action = event.action.type;
    if (action === "fetch" && event.query.state.data === undefined) monitor.queryLoading(event.query.queryHash);
    else if (action === "success" || action === "error") monitor.querySettled(event.query.queryHash);
  });

  monitor.subscribe((m) => console.debug(`[perf] ${m.kind} ${m.flow} ${Math.round(m.ms)}ms (budget ${m.budget}ms)`));
  window.__valetPerf = { entries: () => monitor.entries(), clear: () => monitor.clear() };

  if (mode === "overlay") void import("./overlay").then(({ mountPerfOverlay }) => mountPerfOverlay(monitor));
  return monitor;
}
