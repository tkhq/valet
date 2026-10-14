import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useApiAvailability } from "~/stores/api-availability";

/** Wait this long before showing the banner, so one dropped request does not flash it. */
export const BANNER_DELAY_MS = 1_500;
/** Health poll interval while the api is unavailable. */
export const HEALTH_POLL_MS = 2_000;

/**
 * Shows "Reconnecting" while the api is unavailable, for example during a
 * deploy. GETs retry on their own (`api/client.ts`). This component polls
 * `/api/health` so it also clears when no GET is in flight.
 *
 * When the api becomes available again, by a poll or by any other request,
 * it refetches the queries that failed during the outage. The refetch
 * follows the store transition, not the poll: a retried GET can finish
 * first and clear the outage before the next poll runs.
 *
 * Through the ingress, `/api/health` answers only when the pod is ready:
 * the Service has no endpoint before readiness passes.
 */
export function ApiReconnectingBanner() {
  const unavailableSince = useApiAvailability((s) => s.unavailableSince);
  const queryClient = useQueryClient();
  const [visible, setVisible] = useState(false);

  useEffect(
    () =>
      useApiAvailability.subscribe((state, previous) => {
        if (previous.unavailableSince !== null && state.unavailableSince === null) {
          void queryClient.refetchQueries({ predicate: (query) => query.state.status === "error" });
        }
      }),
    [queryClient],
  );

  useEffect(() => {
    if (unavailableSince === null) {
      setVisible(false);
      return;
    }
    const show = setTimeout(() => setVisible(true), BANNER_DELAY_MS);
    let stopped = false;
    const poll = setInterval(() => {
      void fetch("/api/health", { cache: "no-store" })
        .then((res) => {
          const type = res.headers.get("content-type") ?? "";
          if (!stopped && res.ok && type.includes("application/json")) {
            useApiAvailability.getState().markAvailable();
          }
        })
        .catch(() => {
          // Still unreachable. The next tick tries again.
        });
    }, HEALTH_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(show);
      clearInterval(poll);
    };
  }, [unavailableSince]);

  if (!visible) return null;
  return (
    <div role="status" className="fixed left-1/2 top-3 z-50 -translate-x-1/2 rounded-full border border-line bg-paper px-4 py-1.5 text-sm text-ink shadow-lg">
      Lost connection to Valet. Reconnecting…
    </div>
  );
}
