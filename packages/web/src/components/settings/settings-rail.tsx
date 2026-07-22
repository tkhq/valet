import { Link, useRouterState } from "@tanstack/react-router";
import { useOrg } from "~/api/settings";
import { cn } from "~/lib/cn";

/**
 * The settings shell's left rail (split-settings design, "Visual direction"
 * + "Routes & navigation"). Two small-caps groups: **You** (always present,
 * four items) and **Organization** (three items, shown only once the
 * `useOrg()` query resolves to gate-on + caller-admin — hidden otherwise,
 * never disabled, and rendered with no flash since it appears only once
 * cached data arrives rather than defaulting open then collapsing).
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

const ORGANIZATION_ITEMS = [
  { to: "/settings/organization", label: "General" },
  { to: "/settings/organization/members", label: "Members" },
  { to: "/settings/organization/teams", label: "Teams" },
  { to: "/settings/organization/models", label: "Models" },
  { to: "/settings/organization/github", label: "GitHub" },
  { to: "/settings/organization/sandbox-images", label: "Sandbox images" },
  { to: "/settings/organization/onepassword", label: "1Password" },
] as const;

export function SettingsRail() {
  const orgQ = useOrg();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const showOrganizationGroup =
    orgQ.data?.features.organizations === true && orgQ.data.callerRole === "admin";

  return (
    <nav aria-label="Settings" className="w-full shrink-0 space-y-6 text-sm sm:w-[200px]">
      <RailGroup label="You" items={YOU_ITEMS} pathname={pathname} />
      {showOrganizationGroup && (
        <RailGroup label="Organization" items={ORGANIZATION_ITEMS} pathname={pathname} />
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
