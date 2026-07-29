import { Link, useRouterState } from "@tanstack/react-router";
import type { OrgPermissionWire } from "@valet/api/wire";
import { useOrg } from "~/api/settings";
import { cn } from "~/lib/cn";

/**
 * The settings shell's left rail (split-settings design, "Visual direction"
 * + "Routes & navigation"). Two small-caps groups: **You** (always present,
 * four items) and **Organization** (shown only once the `useOrg()` query
 * resolves to gate-on + the caller holds at least one org permission —
 * hidden otherwise, never disabled, and rendered with no flash since it
 * appears only once cached data arrives rather than defaulting open then
 * collapsing). Within the Organization group, each entry is further gated
 * on the specific permission that entry's page requires (RBAC design):
 * General → `org:manage`, Members/Teams → `members:manage`, Models →
 * `providers:manage`, GitHub/Sandbox images → `infra:manage`. The
 * `features.organizations` gate is unchanged from the earlier admin-only
 * design — it still governs the whole group.
 *
 * Active-state styling is computed from the current pathname (via `cn`'s
 * `twMerge`) rather than TanStack's `activeProps`, which only concatenates
 * class strings — for two same-specificity utilities like `text-muted` and
 * `text-moss`, whichever comes later in the generated stylesheet wins
 * regardless of prop order, which silently dropped the moss active state.
 */

const YOU_ITEMS = [
  { to: "/settings/profile", label: "Profile" },
  { to: "/settings/assistant", label: "Assistant" },
  { to: "/settings/appearance", label: "Appearance" },
  { to: "/settings/notifications", label: "Notifications" },
  { to: "/settings/connected-accounts", label: "Connected accounts" },
  { to: "/settings/api-keys", label: "API keys" },
] as const;

/** Single-user-mode stand-in for Organization · Models — shown under "You"
 * only while the Organization group is hidden (`/settings/models` renders
 * the same sections; the org-admin API authorizes the seeded local user). */
const MODELS_ITEM = { to: "/settings/models", label: "Models" } as const;

const ORGANIZATION_ITEMS: ReadonlyArray<{
  to: string;
  label: string;
  permission: OrgPermissionWire;
}> = [
  { to: "/settings/organization", label: "General", permission: "org:manage" },
  { to: "/settings/organization/members", label: "Members", permission: "members:manage" },
  { to: "/settings/organization/teams", label: "Teams", permission: "members:manage" },
  { to: "/settings/organization/models", label: "Models", permission: "providers:manage" },
  { to: "/settings/organization/github", label: "GitHub", permission: "infra:manage" },
  {
    to: "/settings/organization/sandbox-images",
    label: "Sandbox images",
    permission: "infra:manage",
  },
] as const;

export function SettingsRail() {
  const orgQ = useOrg();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const permissions = orgQ.data?.permissions ?? [];
  const showOrganizationGroup =
    orgQ.data?.features.organizations === true && permissions.length > 0;
  const organizationItems = ORGANIZATION_ITEMS.filter((item) =>
    permissions.includes(item.permission),
  );

  // Wait for `useOrg()` to resolve before appending — same no-flash rule as
  // the Organization group (an org-mode admin must never see the item
  // appear and then vanish).
  const youItems = orgQ.data && !showOrganizationGroup ? [...YOU_ITEMS, MODELS_ITEM] : YOU_ITEMS;

  return (
    <nav aria-label="Settings" className="w-full shrink-0 space-y-6 text-sm sm:w-[200px]">
      <RailGroup label="You" items={youItems} pathname={pathname} />
      {showOrganizationGroup && (
        <RailGroup label="Organization" items={organizationItems} pathname={pathname} />
      )}
    </nav>
  );
}

function RailGroup({
  label,
  items,
  pathname,
}: {
  label: string;
  items: ReadonlyArray<{ to: string; label: string }>;
  pathname: string;
}) {
  return (
    <div>
      <div className="mb-1.5 px-2 text-xs font-medium uppercase tracking-wider text-muted">
        {label}
      </div>
      <ul className="space-y-0.5">
        {items.map((item) => {
          const active = pathname === item.to;
          return (
            <li key={item.to}>
              <Link
                to={item.to}
                className={cn(
                  "block rounded px-2 py-1.5 transition-colors",
                  active
                    ? "bg-moss-wash text-moss"
                    : "text-muted hover:bg-ink-wash hover:text-ink",
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
