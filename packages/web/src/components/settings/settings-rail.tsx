import { Link, useRouterState } from "@tanstack/react-router";
import {
  Bell,
  Blocks,
  Bot,
  Building2,
  ChevronDown,
  Cpu,
  KeyRound,
  Link2,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  User,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useOrg, useTeams } from "~/api/settings";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "~/components/primitives";
import { eligibleTeams } from "~/components/session/assistant-rail";
import { useResponsiveOverlay } from "~/hooks/use-responsive-overlay";
import { cn } from "~/lib/cn";

/**
 * The settings shell's left rail (settings-redesign spec, decision 2). It
 * lists every scope the person can manage at once and never reads the
 * workspace switcher:
 *
 * - **Account**: you.
 * - **Personal workspace**: your own workspace's keys, proxy, agent access,
 *   and policies.
 * - **Your teams**: one item per team you belong to, each opening its own
 *   `/settings/teams/$teamId` pages.
 * - **Organization**: shown once `useOrg()` resolves with the gate on (never
 *   flashes). An admin sees four grouped sections, each a tab bar over its
 *   existing routes (`ORG_SECTIONS`). A plain member sees Teams and 1Password.
 *
 * Active state is computed from the pathname (via `cn`'s `twMerge`) rather
 * than TanStack's `activeProps`, which only concatenates class strings.
 */

/** One source of truth for the Teams path — the rail and the
 * `/settings/organization` route guard must never disagree on it. */
export const ORG_TEAMS_PATH = "/settings/organization/teams";

/** Same rule for 1Password, which every org member may open. */
export const ORG_ONEPASSWORD_PATH = "/settings/organization/onepassword";

export interface OrgRoute {
  to: string;
  label: string;
}

/** The admin's Organization rail items. Each groups existing routes, and the
 * organization layout renders the group's routes as tabs. */
export const ORG_SECTIONS: ReadonlyArray<{ label: string; icon: LucideIcon; routes: readonly OrgRoute[] }> = [
  {
    label: "General",
    icon: Building2,
    routes: [
      { to: "/settings/organization", label: "General" },
      { to: "/settings/organization/members", label: "Members" },
      { to: ORG_TEAMS_PATH, label: "Teams" },
    ],
  },
  {
    label: "Models and usage",
    icon: Cpu,
    routes: [
      { to: "/settings/organization/models", label: "Models" },
      { to: "/settings/organization/proxy", label: "Proxy" },
    ],
  },
  {
    label: "Apps and plugins",
    icon: Blocks,
    routes: [
      { to: "/settings/organization/plugins", label: "Plugins" },
      { to: "/settings/organization/github", label: "GitHub" },
      { to: "/settings/organization/slack", label: "Slack" },
      { to: "/settings/organization/linear", label: "Linear" },
      { to: ORG_ONEPASSWORD_PATH, label: "1Password" },
      { to: "/settings/organization/library", label: "Library" },
    ],
  },
  {
    label: "Security and audit",
    icon: ShieldCheck,
    routes: [
      { to: "/settings/organization/policies", label: "Policies" },
      { to: "/settings/organization/sandbox-images", label: "Sandbox settings" },
      { to: "/settings/organization/action-log", label: "Action log" },
    ],
  },
];

/** The pathname without a trailing slash and in lower case: the router
 * matches slash-tolerantly and case-insensitively, `location.pathname` stays
 * raw. */
export function normalizeSettingsPath(pathname: string): string {
  return pathname.replace(/\/+$/, "").toLowerCase() || "/";
}

/** True when `pathname` is `route` or one of its descendants. */
function onRoute(pathname: string, route: string): boolean {
  const path = normalizeSettingsPath(pathname);
  const target = route.toLowerCase();
  return path === target || path.startsWith(`${target}/`);
}

/** The Organization section that holds `pathname`, if any. The General
 * section's root route matches exactly, so it does not claim every
 * organization page. */
export function orgSectionFor(pathname: string) {
  const path = normalizeSettingsPath(pathname);
  return ORG_SECTIONS.find((section) =>
    section.routes.some((route) =>
      route.to === "/settings/organization" ? path === route.to : onRoute(path, route.to),
    ),
  );
}

interface RailItem {
  to: string;
  label: string;
  icon: LucideIcon;
  active: (pathname: string) => boolean;
}

interface RailGroupSpec {
  label: string;
  items: RailItem[];
}

function exact(to: string): (pathname: string) => boolean {
  return (pathname) => normalizeSettingsPath(pathname) === to;
}

const ACCOUNT_ITEMS: RailItem[] = [
  { to: "/settings/profile", label: "Profile", icon: User, active: exact("/settings/profile") },
  { to: "/settings/preferences", label: "Preferences", icon: SlidersHorizontal, active: exact("/settings/preferences") },
  { to: "/settings/notifications", label: "Notifications", icon: Bell, active: exact("/settings/notifications") },
  { to: "/settings/connected-accounts", label: "Connected accounts", icon: Link2, active: exact("/settings/connected-accounts") },
];

const PERSONAL_ITEMS: RailItem[] = [
  { to: "/settings/api-keys", label: "API keys and proxy", icon: KeyRound, active: exact("/settings/api-keys") },
  { to: "/settings/agent-access", label: "Agent access", icon: Bot, active: exact("/settings/agent-access") },
  { to: "/settings/policies", label: "Policies", icon: Shield, active: exact("/settings/policies") },
];

/** Single-user-mode stand-in for Organization · Models — shown only while
 * the org gate is OFF. A gate-on plain member gets no Models item at all:
 * every section on that page reads org-admin-only APIs. */
const MODELS_ITEM: RailItem = { to: "/settings/models", label: "Models", icon: Cpu, active: exact("/settings/models") };

const MEMBER_ORG_ITEMS: RailItem[] = [
  { to: ORG_TEAMS_PATH, label: "Teams", icon: Users, active: (p) => onRoute(p, ORG_TEAMS_PATH) },
  { to: ORG_ONEPASSWORD_PATH, label: "1Password", icon: KeyRound, active: exact(ORG_ONEPASSWORD_PATH) },
];

const ADMIN_ORG_ITEMS: RailItem[] = ORG_SECTIONS.map((section) => ({
  to: section.routes[0]!.to,
  label: section.label,
  icon: section.icon,
  active: (pathname: string) => orgSectionFor(pathname) === section,
}));

export function SettingsRail() {
  const sectionMenu = useResponsiveOverlay("sm");
  const orgQ = useOrg();
  const teamsQ = useTeams();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const organizationsOn = orgQ.data?.features.organizations === true;
  const orgAdmin = orgQ.data?.callerRole === "admin";

  // Wait for `useOrg()` before adding Models, so an org-mode admin never
  // sees it appear and then vanish.
  const personalItems = orgQ.data && !organizationsOn ? [...PERSONAL_ITEMS, MODELS_ITEM] : PERSONAL_ITEMS;
  const teams = eligibleTeams(teamsQ.data?.teams, orgQ.data?.features.organizations)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  const teamItems: RailItem[] = teams.map((team) => {
    const to = `/settings/teams/${team.id}`;
    return { to, label: team.name, icon: Users, active: (p) => onRoute(p, to.toLowerCase()) };
  });

  const groups: RailGroupSpec[] = [
    { label: "Account", items: ACCOUNT_ITEMS },
    { label: "Personal workspace", items: personalItems },
    ...(teamItems.length > 0 ? [{ label: "Your teams", items: teamItems }] : []),
    ...(organizationsOn ? [{ label: "Organization", items: orgAdmin ? ADMIN_ORG_ITEMS : MEMBER_ORG_ITEMS }] : []),
  ];
  const currentGroup = groups.find((group) => group.items.some((item) => item.active(pathname)));
  const current = currentGroup?.items.find((item) => item.active(pathname));
  const currentLabel = current ? `${currentGroup?.label} / ${current.label}` : "Choose section";

  return (
    <nav aria-label="Settings" className="w-full shrink-0 text-sm sm:w-56">
      <div className="sm:hidden">
        <DropdownMenu open={sectionMenu.open} onOpenChange={sectionMenu.setOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" className="w-full justify-between" aria-label={`Settings section: ${currentLabel}`}>
              <span className="truncate">{currentLabel}</span>
              <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-[var(--radix-dropdown-menu-trigger-width)]">
            {groups.map((group) => (
              <DropdownMenuGroup key={group.label} aria-label={group.label}>
                <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
                {group.items.map((item) => {
                  const active = item.active(pathname);
                  return (
                    <DropdownMenuItem key={item.to} asChild>
                      <Link to={item.to} aria-current={active ? "page" : undefined} className={active ? "bg-ink-wash text-ink" : undefined}>
                        <item.icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                        {item.label}
                      </Link>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuGroup>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="hidden space-y-5 sm:block">
        {groups.map((group) => <RailGroup key={group.label} {...group} pathname={pathname} />)}
      </div>
    </nav>
  );
}

function RailGroup({ label, items, pathname }: RailGroupSpec & { pathname: string }) {
  return (
    <div role="group" aria-label={label}>
      <div className="mb-1 px-2.5 text-xs text-muted">{label}</div>
      <ul className="space-y-0.5">
        {items.map((item) => {
          const active = item.active(pathname);
          return (
            <li key={item.to}>
              <Link
                to={item.to}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors",
                  active ? "bg-ink-wash text-ink" : "text-muted hover:bg-ink-wash hover:text-ink",
                )}
              >
                <item.icon className="h-4 w-4 shrink-0" aria-hidden />
                <span className="truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
