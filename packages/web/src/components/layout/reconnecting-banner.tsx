import { useApiConnection } from "~/api/connection";
import { Callout } from "~/components/primitives/callout";
import { Spinner } from "~/components/primitives/spinner";

/**
 * The one notice for an api outage. Panels keep their data and show no
 * errors while the api is down (`connection.ts`), so this banner is the
 * only sign of it. It floats below the nav, centered. An outage longer than
 * a restart (`UNREACHABLE_AFTER_MS`) says that Valet is unreachable, while
 * the probe keeps trying.
 */
export function ReconnectingBanner() {
  const reconnecting = useApiConnection((s) => s.status === "reconnecting");
  const unreachable = useApiConnection((s) => s.unreachable === true);
  if (!reconnecting) return null;
  const offline = typeof navigator !== "undefined" && !navigator.onLine;
  return (
    // The tone's wash is translucent, so a paper base keeps the page text
    // under the banner from showing through.
    <div className="fixed left-1/2 top-[calc(var(--nav-height)+0.5rem)] z-50 -translate-x-1/2 rounded bg-paper shadow-lg">
      <Callout role="status" tone="warning" className="flex items-center gap-2 whitespace-nowrap">
        <Spinner size={14} />
        {offline
          ? "You are offline. Reconnecting…"
          : unreachable
            ? "Valet is unreachable. Still trying to reconnect…"
            : "Valet is restarting. Reconnecting…"}
      </Callout>
    </div>
  );
}
