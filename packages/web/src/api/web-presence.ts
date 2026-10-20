import { useEffect } from "react";
import { api } from "./client";

const RECENT_INPUT_MS = 120_000;
const HEARTBEAT_MS = 20_000;

/** Each mounted tab reports separately. A hidden tab cannot clear another tab. */
export function useWebPresence(): void {
  useEffect(() => {
    const tabId = crypto.randomUUID();
    let lastInputAt = Number.NEGATIVE_INFINITY;
    let reportedActive = false;
    const report = (force = false) => {
      const active = document.visibilityState === "visible" && Date.now() - lastInputAt < RECENT_INPUT_MS;
      if (force || active !== reportedActive) {
        reportedActive = active;
        void api.reportWebPresence({ tabId, active }).catch(() => {
          // Presence is advisory. A missing heartbeat expires on the server.
        });
      }
    };
    const input = () => { lastInputAt = Date.now(); report(); };
    const visibility = () => report(true);
    const events = ["pointerdown", "pointermove", "keydown", "scroll", "touchstart"] as const;
    for (const event of events) window.addEventListener(event, input, { passive: true });
    document.addEventListener("visibilitychange", visibility);
    const timer = window.setInterval(() => report(reportedActive), HEARTBEAT_MS);
    return () => {
      window.clearInterval(timer);
      for (const event of events) window.removeEventListener(event, input);
      document.removeEventListener("visibilitychange", visibility);
      void api.reportWebPresence({ tabId, active: false }).catch(() => {});
    };
  }, []);
}
