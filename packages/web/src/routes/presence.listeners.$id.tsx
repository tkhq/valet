import { createFileRoute } from "@tanstack/react-router";
import { ListenerPage } from "~/components/presence/listener-page";

/** `/presence/listeners/$id`: one listener. It replaces the inline edit and
 * review of the Subscriptions tab of `/events`. */
export const Route = createFileRoute("/presence/listeners/$id")({
  component: ListenerPageRoute,
});

function ListenerPageRoute() {
  const { id } = Route.useParams();
  return <ListenerPage id={id} />;
}
