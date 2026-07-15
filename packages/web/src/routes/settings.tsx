import { Outlet, createFileRoute } from "@tanstack/react-router";
import { SettingsRail } from "~/components/settings/settings-rail";

/**
 * `/settings` layout shell (split-settings design, decision 1): left rail +
 * routed section content via `<Outlet/>`. Reached via the gear icon in the
 * top nav. `/settings` itself has no content of its own — it redirects to
 * `/settings/profile` (`settings.index.tsx`).
 */
export const Route = createFileRoute("/settings")({
  component: SettingsLayout,
});

export function SettingsLayout() {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <h1 className="mb-8 font-display text-2xl text-ink">Settings</h1>
        <div className="flex flex-col gap-8 sm:flex-row sm:gap-12">
          <SettingsRail />
          <div className="min-w-0 max-w-2xl flex-1">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}
