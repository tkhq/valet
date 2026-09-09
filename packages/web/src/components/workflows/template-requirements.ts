/**
 * What a template needs before it can be installed, read from the
 * requirements the server stamps on each summary.
 *
 * Two surfaces ask the same question and must give the same answer: the
 * gallery card decides which control to offer, and the install dialog
 * decides whether Install can be pressed and what to say when it cannot.
 * The rules live here so the two cannot drift, and so neither file has to
 * import the other.
 *
 * A requirement reports two different states, and they need different
 * words. `connected: false` is a gap the reader can close on the
 * integrations page. `unconfigured: true` is the deployment's gap — the
 * org has not set the service up — and only an admin can close it. The
 * integrations page hides an unconfigured service
 * (integration-availability design), so sending the reader there for one
 * is sending them to a page with nothing on it.
 *
 * `connected` carries no principal of its own. The server stamps it
 * against whatever the listing asked about, and the listing asks about the
 * workspace the nav switcher names: the reader in their own workspace, the
 * TEAM in a team workspace, because that is the principal the install acts
 * as. So the copy takes the same scope. A team's missing credential
 * reported as the reader's own would send somebody to connect a service
 * they already have.
 */
import type { WorkflowTemplateRequirement } from "@valet/api/wire";
import { displayName } from "~/components/integrations/display-name";

/** Whose gap a requirement reports: the reader's, or the team workspace's. */
export type RequirementScope = "personal" | "team";

/** The scope a workspace maps to. `teamId` is `useWorkspaceScope().teamId`,
 * which is undefined in your own workspace and a team id in a team's. */
export function requirementScope(teamId: string | undefined): RequirementScope {
  return teamId === undefined ? "personal" : "team";
}

/**
 * The services a template needs that the active workspace has not connected
 * AND could connect. An unconfigured service is excluded: no page offers
 * it, so naming it on a Connect button would send the reader nowhere.
 */
export function missingServices(requires: WorkflowTemplateRequirement[]): string[] {
  return requires
    .filter((r) => !r.connected && r.unconfigured !== true)
    .map((r) => displayName(r.service));
}

/** The services this organization has not set up. Only an admin can act. */
export function unconfiguredServices(requires: WorkflowTemplateRequirement[]): string[] {
  return requires.filter((r) => r.unconfigured === true).map((r) => displayName(r.service));
}

/** True when every service this template needs is ready for the workspace
 * the listing was taken in. */
export function isInstallable(requires: WorkflowTemplateRequirement[]): boolean {
  return missingServices(requires).length === 0 && unconfiguredServices(requires).length === 0;
}

/**
 * One sentence for the services an admin has to set up, worded like the
 * integrations page's own note so the two surfaces read the same. The org
 * answers this the same way for every workspace, so it takes no scope.
 */
export function unconfiguredNote(names: string[]): string {
  const subject = names.length === 1 ? `${names[0]} is` : `${names.join(", ")} are`;
  return `${subject} not configured for this organization. An admin can set this up in Settings → Organization.`;
}

/**
 * One sentence for the services the workspace is missing, in the shape the
 * repo's error rule asks for: the fact, then the action.
 *
 * A team run reads the TEAM's credential and never a member's own, so the
 * team wording names the whole chain that closes the gap. Connecting the
 * service is only half of it: the connection then has to be shared with
 * the team, which is what the Integrations page's "Share with a team"
 * control does.
 */
export function missingNote(names: string[], scope: RequirementScope): string {
  const subject = names.length === 1 ? `${names[0]} is` : `${names.join(", ")} are`;
  if (scope === "team") {
    const what = names.length === 1 ? names[0] : "them";
    const them = names.length === 1 ? "it" : "them";
    return (
      `${subject} not connected for this team. Connect ${what} on the Integrations page and ` +
      `share ${them} with the team, then install this template.`
    );
  }
  return `${subject} not connected on your account. Connect ${names.length === 1 ? "it" : "them"} on the Integrations page, then install this template.`;
}

/**
 * The card's control for a template the workspace cannot install yet. It
 * links to Integrations either way; the label names the work waiting there,
 * which is a connection of your own in your workspace and a shared one in a
 * team's ("Share with a team" is that page's own control).
 */
export function connectLabel(names: string[], scope: RequirementScope): string {
  const what = names.length === 1 ? names[0] : "integrations";
  return scope === "team" ? `Share ${what} with the team` : `Connect ${what}`;
}
