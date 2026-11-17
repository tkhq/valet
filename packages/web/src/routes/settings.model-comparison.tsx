import { createFileRoute } from "@tanstack/react-router";
import { Section } from "~/components/settings/section";
import { ModelComparisonTable } from "~/components/settings/model-comparison-table";

/**
 * `/settings/model-comparison` — every member's view of the org's models
 * with list prices, benchmark standing and a value index
 * (docs/specs/2026-10-30-model-comparison-page-design.md). Reads only
 * `GET /api/models`, which needs no admin gate, so it lives under Personal
 * in both org and single-user mode.
 */
export const Route = createFileRoute("/settings/model-comparison")({
  component: ModelComparisonPage,
});

export function ModelComparisonPage() {
  return (
    <Section
      title="Model comparison"
      description="List prices, context, benchmark standing and a value index for every model you can pick."
    >
      <ModelComparisonTable />
    </Section>
  );
}
