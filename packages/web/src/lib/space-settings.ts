import { PERSONAL } from "~/lib/workspace-scope";

/** The space pages that live in Settings: one home per space. */
export type SpaceSettingsTab = "integrations" | "usage";

/**
 * Where a space's settings live: your own workspace's pages under
 * Personal workspace, a team's under `/settings/teams/$teamId`. With no
 * tab, a team opens its General tab and your own workspace its
 * Integrations.
 */
export function spaceSettingsHref(key: string, tab?: SpaceSettingsTab): string {
  if (key === PERSONAL) return `/settings/${tab ?? "integrations"}`;
  return `/settings/teams/${encodeURIComponent(key)}${tab ? `/${tab}` : ""}`;
}
