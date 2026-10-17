import { createFileRoute } from "@tanstack/react-router";
import { RulePage } from "~/components/presence/rule-page";

/** `/presence/rules/$id`: one line of presence, in the pane. It replaces
 * `/presence/listeners/$id` (spec Part A step 3), which redirects here. */
export const Route = createFileRoute("/presence/rules/$id")({
  component: RulePageRoute,
});

function RulePageRoute() {
  const { id } = Route.useParams();
  return <RulePage id={id} />;
}
