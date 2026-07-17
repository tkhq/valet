import { createFileRoute } from "@tanstack/react-router";
import { ImageCatalogSection } from "~/components/settings/image-catalog-section";
import { PrebuildsSection } from "~/components/settings/prebuilds-section";

/**
 * `/settings/organization/sandbox-images` — Organization · Sandbox images
 * (sandbox images v2 plan, Task 6). Base-image catalog above, per-repo
 * prebuild configs + build history below. Renders inside
 * `/settings/organization`'s `OrgRouteGuard` — no per-page admin re-check.
 */
export const Route = createFileRoute("/settings/organization/sandbox-images")({
  component: OrganizationSandboxImagesPage,
});

export function OrganizationSandboxImagesPage() {
  return (
    <div className="space-y-10">
      <ImageCatalogSection />
      <PrebuildsSection />
    </div>
  );
}
