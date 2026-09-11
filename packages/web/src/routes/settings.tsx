import { Navigate, Outlet, createFileRoute, useRouterState } from "@tanstack/react-router";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { SettingsRail, TEAM_SETTINGS_PATH } from "~/components/settings/settings-rail";

/**
 * `/settings` layout shell (split-settings design, decision 1): left rail +
 * routed section content via `<Outlet/>`. Reached via the gear icon in the
 * top nav. `/settings` itself redirects to `/settings/profile`.
 *
 * A selected team adds team settings to the rail. It does not replace personal
 * settings or redirect personal and organization routes. This keeps the team
 * selection while a person moves between settings sections.
 */
export const Route = createFileRoute("/settings")({
  component: SettingsLayout,
});

export function SettingsLayout() {
  const { teamId, key } = useWorkspaceScope();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const redirectTo = teamId === undefined && pathname === TEAM_SETTINGS_PATH
    ? "/settings/profile"
    : undefined;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <h1 className="mb-8 font-display text-2xl text-ink">Settings</h1>
        <div className="flex flex-col gap-8 sm:flex-row sm:gap-12">
          <SettingsRail />
          <div className="min-w-0 max-w-2xl flex-1">
            {redirectTo ? <Navigate to={redirectTo} replace /> : <Outlet key={key} />}
          </div>
        </div>
      </div>
    </div>
  );
}
