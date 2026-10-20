import { createFileRoute } from "@tanstack/react-router";
import { RoutinePage } from "~/components/presence/routine-page";

/** `/presence/routines/$id`: one routine's page (spec Part E step 2), a
 * drill-in from the overview's `On a schedule` group. The old
 * `/presence/routines?routine=<id>` redirects here. */
export const Route = createFileRoute("/presence/routines/$id")({
  component: RoutineRoute,
});

function RoutineRoute() {
  const { id } = Route.useParams();
  return <RoutinePage id={id} />;
}
