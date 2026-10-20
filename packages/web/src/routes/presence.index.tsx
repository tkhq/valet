import { createFileRoute } from "@tanstack/react-router";
import { Overview } from "~/components/presence/overview";

/** `/presence`: the section lands on the overview of every place, never on
 * a place or on Activity (spec Part A step 5, Part B). */
export const Route = createFileRoute("/presence/")({
  component: Overview,
});
