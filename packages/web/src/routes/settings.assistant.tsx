import { createFileRoute } from "@tanstack/react-router";
import { Section } from "~/components/settings/section";

/**
 * `/settings/assistant` — You · Assistant. Placeholder stub; Task 6 extracts
 * `IdentityStep`'s name/personality editing into shared
 * `components/assistant/identity-fields.tsx` and adds the default-model
 * typeahead over `GET /api/models`.
 */
export const Route = createFileRoute("/settings/assistant")({
  component: AssistantPage,
});

export function AssistantPage() {
  return (
    <Section title="Assistant" description="Your assistant's name, personality, and default model.">
      <p className="py-4 text-sm text-muted">Assistant identity editing lands here next.</p>
    </Section>
  );
}
