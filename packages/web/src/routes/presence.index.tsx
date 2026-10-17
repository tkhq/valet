import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PlacesTab, type PlacesView } from "~/components/presence/places-tab";

/** The Places tab's search: `?view=all` shows the All listeners table, so
 * Back and a shared link keep the view. Any other value reads as places. */
export function readPlacesSearch(raw: unknown): { view?: "all" } {
  return typeof raw === "object" && raw !== null && "view" in raw && raw.view === "all" ? { view: "all" } : {};
}

/** `/presence`: the Places tab, the index of the Presence section. It replaces the Channels tab of `/events`. */
export const Route = createFileRoute("/presence/")({
  validateSearch: readPlacesSearch,
  component: PlacesTabRoute,
});

function PlacesTabRoute() {
  const { view } = Route.useSearch();
  const navigate = useNavigate();
  const current: PlacesView = view === "all" ? "listeners" : "places";
  return (
    <PlacesTab
      view={current}
      onViewChange={(next) => void navigate({ to: "/presence", search: next === "listeners" ? { view: "all" } : {} })}
    />
  );
}
