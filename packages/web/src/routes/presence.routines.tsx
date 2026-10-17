import { createFileRoute } from "@tanstack/react-router";
import { PresencePlaceholder } from "~/components/presence/page-shell";

/** `/presence/routines`: what Valet does at a set time. It replaces the Scheduled tab of `/workflows`. */
export const Route = createFileRoute("/presence/routines")({
  component: RoutinesTab,
});

export function RoutinesTab() {
  return <PresencePlaceholder>This tab lists what Valet does at a set time.</PresencePlaceholder>;
}
