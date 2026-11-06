import { createFileRoute } from "@tanstack/react-router";
import { UsagePage } from "./usage";

/** A team's spend. The team layout pins the team's scope. */
export const Route = createFileRoute("/settings/teams/$teamId/usage")({
  component: UsagePage,
});
