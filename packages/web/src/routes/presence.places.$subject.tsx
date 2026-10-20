import { createFileRoute } from "@tanstack/react-router";
import { PlacePage } from "~/components/presence/place-page";

/** `/presence/places/$subject`: one place, such as `#incidents` or `acme/api`. It
 * replaces `/channel?key=`. The param is the place key, such as `slack:T1/C123`. */
export const Route = createFileRoute("/presence/places/$subject")({
  // `workspace` picks the workspace the place reads in (the scope provider
  // reads it); a thread header sends its owner's.
  validateSearch: (search: Record<string, unknown>): { workspace?: string } =>
    typeof search.workspace === "string" && search.workspace.length > 0 ? { workspace: search.workspace } : {},
  component: PlacePageRoute,
});

function PlacePageRoute() {
  const { subject } = Route.useParams();
  return <PlacePage subject={subject} />;
}
