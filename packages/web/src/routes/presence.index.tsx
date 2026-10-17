import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ActivityTab, readActivitySearch, type ActivitySearch } from "~/components/presence/activity-tab";

/** `/presence`: the section lands on Activity, never on a place (spec Part A
 * step 5). `/presence/activity` shows the same pane. */
export const Route = createFileRoute("/presence/")({
  validateSearch: readActivitySearch,
  component: PresenceIndexRoute,
});

function PresenceIndexRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  // Writes the filters to the URL, so Back and a shared link restore them.
  const onSearchChange = (next: ActivitySearch) => void navigate({ to: "/presence", search: next });
  return <ActivityTab search={search} onSearchChange={onSearchChange} />;
}
