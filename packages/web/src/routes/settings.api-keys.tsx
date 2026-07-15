import { createFileRoute } from "@tanstack/react-router";
import { Section } from "~/components/settings/section";
import { ApiKeysSection } from "~/components/settings/api-keys-section";

/**
 * `/settings/api-keys` — You · API keys. Scripts and CI can call the Valet
 * API with a key created here instead of a signed-in session.
 */
export const Route = createFileRoute("/settings/api-keys")({
  component: ApiKeysPage,
});

export function ApiKeysPage() {
  return (
    <Section title="API keys" description="Create keys to call the Valet API from scripts.">
      <ApiKeysSection />
    </Section>
  );
}
