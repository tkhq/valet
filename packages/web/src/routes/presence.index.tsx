import { createFileRoute } from "@tanstack/react-router";
import { PresencePlaceholder } from "~/components/presence/page-shell";

/** `/presence`: the Places tab, the index of the Presence section. It replaces the Channels tab of `/events`. */
export const Route = createFileRoute("/presence/")({
  component: PlacesTab,
});

export function PlacesTab() {
  return <PresencePlaceholder>This tab lists the channels, repositories, and teams where Valet listens.</PresencePlaceholder>;
}
