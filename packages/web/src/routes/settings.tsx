import { Outlet, createFileRoute, useRouterState } from "@tanstack/react-router";
import { SettingsRail, normalizeSettingsPath } from "~/components/settings/settings-rail";
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

/** Routes whose content is a wide table rather than a settings form. */
const WIDE_SETTINGS_ROUTES = ["/settings/model-comparison", "/settings/organization/model-comparison"];

export function SettingsLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const wide = WIDE_SETTINGS_ROUTES.includes(normalizeSettingsPath(pathname));
  return (
    <div className="flex-1 overflow-y-auto">
      <div className={pageClass}>
        <PageHeader title="Settings" className="mb-4 sm:mb-8" />
        <div className="flex flex-col gap-4 sm:flex-row sm:gap-10">
          <SettingsRail />
          <div className={wide ? "min-w-0 flex-1" : "min-w-0 max-w-3xl flex-1"}>
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}
