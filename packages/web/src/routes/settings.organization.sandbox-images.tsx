import { createFileRoute } from "@tanstack/react-router";
import { SourcesSection } from "~/components/settings/sources-section";

/**
 * `/settings/organization/sandbox-images` — Organization · Sandbox images
 * (sandbox-reconciliation plan, Task 18). Three groups on one page: base
 * image, repository images, external images. Renders inside
 * `/settings/organization`'s `OrgRouteGuard` — no per-page admin re-check.
 */
export const Route = createFileRoute("/settings/organization/sandbox-images")({
  component: OrganizationSandboxImagesPage,
});

export function OrganizationSandboxImagesPage() {
  return (
    <div className="space-y-10">
      <SourcesSection />
    </div>
  );
}
