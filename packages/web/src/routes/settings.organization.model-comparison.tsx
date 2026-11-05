import { createFileRoute } from "@tanstack/react-router";
import { ModelComparisonPage } from "~/components/settings/model-comparison-page";

/**
 * `/settings/organization/model-comparison` — Organization · Models and
 * usage · Compare. The same read-only table as `/settings/model-comparison`,
 * placed beside the Models card where admins curate the catalog. Renders
 * inside `/settings/organization`'s OrgRouteGuard — no per-page admin re-check.
 */
export const Route = createFileRoute("/settings/organization/model-comparison")({
  component: ModelComparisonPage,
});
