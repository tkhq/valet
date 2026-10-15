import { Suspense } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { UiStressGallery, requireUiStress } from "~/dev/ui-stress/gate";

/**
 * `/dev/ui-stress` — development only. Renders real components with extreme
 * fixture data, so one page shows the layout breaks at 375, 760, and
 * 1280 px. No nav links here. A production build answers 404, and its bundle
 * holds no gallery code (see `~/dev/ui-stress/gate`).
 */
export const Route = createFileRoute("/dev/ui-stress")({
  beforeLoad: requireUiStress,
  component: UiStressPage,
});

function UiStressPage() {
  if (!UiStressGallery) return null;
  return (
    <Suspense fallback={<p role="status" className="p-6 text-sm text-muted">Loading the UI stress gallery…</p>}>
      <UiStressGallery />
    </Suspense>
  );
}
