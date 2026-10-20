import { Outlet, createFileRoute } from "@tanstack/react-router";
import { SettingsRail } from "~/components/settings/settings-rail";
import { PageHeader, pageClass } from "~/components/primitives";

/**
 * `/settings` layout shell: left rail + routed section content via
 * `<Outlet/>`. Reached via the gear icon in the top nav. Settings does not
 * follow the workspace switcher: each page names its scope in the URL and
 * pins it (settings-redesign spec, decision 1).
 */
export const Route = createFileRoute("/settings")({
  component: SettingsLayout,
});

export function SettingsLayout() {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className={pageClass}>
        <PageHeader title="Settings" className="mb-4 sm:mb-8" />
        <div className="flex flex-col gap-4 sm:flex-row sm:gap-10">
          <SettingsRail />
          <div className="min-w-0 max-w-3xl flex-1">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}
