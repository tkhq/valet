import { createFileRoute } from "@tanstack/react-router";
import { ImageCatalogSection } from "~/components/settings/image-catalog-section";
import { PrebuildsSection } from "~/components/settings/prebuilds-section";
import { OrgPermissionGuard } from "./settings.organization";

/**
 * `/settings/organization/sandbox-images` — Organization · Sandbox images
 * (sandbox images v2 plan, Task 6). Base-image catalog above, per-repo
 * prebuild configs + build history below. Gated on `infra:manage` (RBAC
 * design) — matches the API's `image-catalog.ts`/`prebuilds.ts` route gate.
 */
export const Route = createFileRoute("/settings/organization/sandbox-images")({
  component: OrganizationSandboxImagesPage,
});

export function OrganizationSandboxImagesPage() {
  return (
    <OrgPermissionGuard permission="infra:manage">
      <div className="space-y-10">
        <ImageCatalogSection />
        <PrebuildsSection />
      </div>
    </OrgPermissionGuard>
  );
}
