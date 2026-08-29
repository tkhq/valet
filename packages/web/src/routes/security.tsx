import { Outlet, createFileRoute } from "@tanstack/react-router";
import { pluginEnabledForCaller, useOrg } from "~/api/settings";

/**
 * `/security` layout shell. Thin — an `<Outlet/>` boundary so the hub
 * (`security.index.tsx`) and any later child pages nest under one path
 * without the hub doubling as their parent (mirrors `workflows.tsx`).
 *
 * Gated on the `security` plugin's entitlement for the caller
 * (plugin-entitlements design). A direct navigation to `/security` when the
 * plugin is not enabled shows a quiet empty state, not the hub — mirroring
 * `OrgRouteGuard` in `settings.organization.tsx`. While the org query loads,
 * render nothing rather than guess "not allowed" or flash the hub.
 */
export const Route = createFileRoute("/security")({
  component: SecurityLayout,
});

export function SecurityLayout() {
  const orgQ = useOrg();
  const enabled = pluginEnabledForCaller(orgQ.data, "security");

  // No flash: wait for the org query before deciding.
  if (enabled === undefined) return null;

  if (!enabled) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center px-6 py-10 text-center text-sm text-muted">
        <p>
          Valet Security is not enabled for your account. Ask an org admin to
          enable it.
        </p>
      </div>
    );
  }

  return <Outlet />;
}
