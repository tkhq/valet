import type { FileRouteTypes } from "~/routeTree.gen";
import { PERSONAL } from "~/lib/workspace-scope";

/** The space pages that live in Settings: one home per space. */
export type SpaceSettingsTab = "integrations" | "usage";

/** A typed route and its params, as `Link` takes them. */
export interface SpaceSettingsTarget {
  to: FileRouteTypes["to"];
  params?: { teamId: string };
}

/**
 * Where a space's settings live: your own workspace's pages under
 * Personal, a team's under `/settings/teams/$teamId`. With no tab, a team
 * opens its General tab and your own workspace its Integrations. The
 * sidebar's Settings row and the old-path redirects share this one rule.
 * The gear in the top bar opens Account (Profile) instead.
 */
export function spaceSettingsTarget(key: string, tab?: SpaceSettingsTab): SpaceSettingsTarget {
  if (key === PERSONAL) return { to: tab === "usage" ? "/settings/usage" : "/settings/integrations" };
  const params = { teamId: key };
  if (tab === "usage") return { to: "/settings/teams/$teamId/usage", params };
  if (tab === "integrations") return { to: "/settings/teams/$teamId/integrations", params };
  return { to: "/settings/teams/$teamId", params };
}

/** `spaceSettingsTarget` as a URL path, for a redirect that keeps a query. */
export function spaceSettingsHref(key: string, tab?: SpaceSettingsTab): string {
  const { to, params } = spaceSettingsTarget(key, tab);
  return params ? to.replace("$teamId", encodeURIComponent(params.teamId)) : to;
}
