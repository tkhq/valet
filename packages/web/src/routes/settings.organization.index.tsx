import { createFileRoute } from "@tanstack/react-router";
import { Section } from "~/components/settings/section";

/**
 * `/settings/organization` (index) — Organization · General. Placeholder
 * stub, reachable only through the `settings.organization.tsx` guard; Task
 * 7 wires org name rename + the disable-gate control here.
 */
export const Route = createFileRoute("/settings/organization/")({
  component: OrganizationGeneralPage,
});

export function OrganizationGeneralPage() {
  return (
    <Section title="General" description="Org name, id, and organization features.">
      <p className="py-4 text-sm text-muted">Org settings land here next.</p>
    </Section>
  );
}
