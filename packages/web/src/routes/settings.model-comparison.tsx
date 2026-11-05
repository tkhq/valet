import { createFileRoute } from "@tanstack/react-router";
import { ModelComparisonPage } from "~/components/settings/model-comparison-page";

/**
 * `/settings/model-comparison` — every member's view of the org's models
 * with list prices, benchmark standing and a value index
 * (docs/specs/2026-10-30-model-comparison-page-design.md). Reads only
 * `GET /api/models`, which needs no admin gate, so it lives under Personal
 * workspace in both org and single-user mode. Admins reach the same table
 * as the organization "Compare" tab.
 */
export const Route = createFileRoute("/settings/model-comparison")({
  component: ModelComparisonPage,
});
