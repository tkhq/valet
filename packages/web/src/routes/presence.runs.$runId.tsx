import { createFileRoute } from "@tanstack/react-router";
import { PresenceDetailPage, PresencePlaceholder } from "~/components/presence/page-shell";

/** `/presence/runs/$runId`: one workflow run. It replaces `/workflows/runs/$runId`. */
export const Route = createFileRoute("/presence/runs/$runId")({
  component: PresenceRunPage,
});

export function PresenceRunPage() {
  return (
    <PresenceDetailPage back="/presence/runs" backLabel="Runs" title="Run">
      <PresencePlaceholder>This page shows the workflow run.</PresencePlaceholder>
    </PresenceDetailPage>
  );
}
