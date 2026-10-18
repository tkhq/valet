import { createFileRoute } from "@tanstack/react-router";
import { RoutinePage } from "~/components/presence/routine-page";

/** `/presence/routines/$id`: one routine's page (spec Part E step 2). The
 * Needs attention banner links a routine that is off here. */
export const Route = createFileRoute("/presence/routines/$id")({
  component: RoutineRoute,
});

function RoutineRoute() {
  const { id } = Route.useParams();
  return <RoutinePage id={id} />;
}
