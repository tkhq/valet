import { Section } from "~/components/settings/section";
import { ModelComparisonTable } from "~/components/settings/model-comparison-table";

/** The page body shared by the personal route and the organization tab. */
export function ModelComparisonPage() {
  return (
    <div className="space-y-10">
      <Section
        title="Model comparison"
        description="List prices, context, benchmark standing and a value index for every model you can pick."
      >
        <ModelComparisonTable />
      </Section>
    </div>
  );
}
