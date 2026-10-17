import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ActivityTab, readActivitySearch, type ActivitySearch } from "~/components/presence/activity-tab";

/** `/presence/activity`: what happened, and what Valet did. It replaces the
 * Log tab of `/events`; the legacy `tab`, `status`, and `q` values redirect
 * here (`-presence-redirects.ts`). */
export const Route = createFileRoute("/presence/activity")({
  validateSearch: readActivitySearch,
  component: ActivityRoute,
});

function ActivityRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  // Writes the filters to the URL, so Back and a shared link restore them.
  const onSearchChange = (next: ActivitySearch) => void navigate({ to: "/presence/activity", search: next });
  return <ActivityTab search={search} onSearchChange={onSearchChange} />;
}
