import { createFileRoute } from "@tanstack/react-router";
import { PresencePlaceholder } from "~/components/presence/page-shell";

/** `/presence/activity`: what happened, and what Valet did. It replaces the Log tab of `/events`. */
export const Route = createFileRoute("/presence/activity")({
  component: ActivityTab,
});

export function ActivityTab() {
  return <PresencePlaceholder>This tab lists what happened and what Valet did.</PresencePlaceholder>;
}
