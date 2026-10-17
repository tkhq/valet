import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PlacesTab, type PlacesView } from "~/components/presence/places-tab";

/** `/presence`: the Places tab, the index of the Presence section. It replaces the Channels tab of `/events`. */
export const Route = createFileRoute("/presence/")({
  component: PlacesTabRoute,
});

function PlacesTabRoute() {
  const [view, setView] = useState<PlacesView>("places");
  return <PlacesTab view={view} onViewChange={setView} />;
}
