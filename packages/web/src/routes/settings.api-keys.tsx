import { createFileRoute } from "@tanstack/react-router";
import { Section } from "~/components/settings/section";
import { ApiKeysSection } from "~/components/settings/api-keys-section";
import { WorkspaceClause } from "~/components/workspace-clause";

/**
 * `/settings/api-keys` follows the workspace switcher. Personal scope
 * creates a personal `vlt_` key. Team scope creates a key that
 * authenticates as that team.
 */
export const Route = createFileRoute("/settings/api-keys")({
  component: ApiKeysPage,
});

export function ApiKeysPage() {
  return (
    <Section
      title={
        <span className="inline-flex flex-wrap items-baseline gap-x-2">
          API keys
          <WorkspaceClause />
        </span>
      }
      description="Create keys to call the Valet API from scripts."
    >
      <ApiKeysSection />
    </Section>
  );
}
