import { createFileRoute } from "@tanstack/react-router";
import { RoutinePage } from "~/components/presence/routine-page";
import { RoutinesTab } from "~/components/presence/routines-tab";

/** `/presence/routines`: what Valet does at a set time. It replaces the
 * Scheduled tab of `/workflows`. `?routine=<id>` opens one routine's page in
 * the tab. */
export const Route = createFileRoute("/presence/routines")({
  validateSearch: (search: Record<string, unknown>): { routine?: string } =>
    typeof search.routine === "string" && search.routine.length > 0 ? { routine: search.routine } : {},
  component: RoutinesRoute,
});

function RoutinesRoute() {
  const { routine } = Route.useSearch();
  return routine === undefined ? <RoutinesTab /> : <RoutinePage id={routine} />;
}
