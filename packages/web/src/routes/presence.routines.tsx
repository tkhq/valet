import { createFileRoute } from "@tanstack/react-router";
import { RoutinePage } from "~/components/presence/routine-page";
import { RoutinesPane } from "~/components/presence/routines-pane";

/** `/presence/routines`: what Valet does at a set time. It replaces the
 * Scheduled tab of `/workflows`. `?routine=<id>` opens one routine's page in
 * the pane. */
export const Route = createFileRoute("/presence/routines")({
  validateSearch: (search: Record<string, unknown>): { routine?: string } =>
    typeof search.routine === "string" && search.routine.length > 0 ? { routine: search.routine } : {},
  component: RoutinesRoute,
});

function RoutinesRoute() {
  const { routine } = Route.useSearch();
  return routine === undefined ? <RoutinesPane /> : <RoutinePage id={routine} />;
}
