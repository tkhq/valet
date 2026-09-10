/**
 * What a template needs before it can be installed, read from the
 * requirements the server stamps on each summary. The gallery card and the
 * install dialog both ask, so the rules live here.
 *
 * `connected` carries no principal of its own. The server stamps it against
 * whatever the listing asked about, and the listing asks about the workspace
 * the nav switcher names: the reader in their own workspace, the TEAM in a
 * team workspace, because that is the principal the install acts as. So the
 * copy takes the same scope. A team's missing credential reported as the
 * reader's own would send somebody to connect a service they already have.
 * The wording below therefore takes the active `teamId` and reads its
 * presence, not its value.
 */
import type { WorkflowTemplateRequirement } from "@valet/api/wire";
import { displayName } from "~/components/integrations/display-name";

/**
 * The services the active workspace has not connected AND could connect. An
 * unconfigured service is excluded: the integrations page hides it
 * (integration-availability design), so naming it on a Connect button would
 * send the reader to a page with nothing on it.
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

export function isInstallable(requires: WorkflowTemplateRequirement[], blockers: string[] = []): boolean {
  return blockers.length === 0 && missingServices(requires).length === 0 && unconfiguredServices(requires).length === 0;
}

/** One sentence for the services an admin has to set up, worded like the
 * integrations page's own note. The org answers this the same way for every
 * workspace, so it takes no team id. */
export function unconfiguredNote(names: string[]): string {
  const subject = names.length === 1 ? `${names[0]} is` : `${names.join(", ")} are`;
  return `${subject} not configured for this organization. An admin can set this up in Settings → Organization.`;
}

/**
 * One sentence for the services the workspace is missing: the fact, then the
 * action.
 *
 * A team run reads the TEAM's credential and never a member's own, so the
 * team wording names the whole chain that closes the gap. Connecting the
 * service is only half of it; the connection then has to be shared with the
 * team, which is what the Integrations page's "Share with a team" control
 * does.
 */
export function missingNote(names: string[], teamId: string | undefined): string {
  const subject = names.length === 1 ? `${names[0]} is` : `${names.join(", ")} are`;
  if (teamId !== undefined) {
    const what = names.length === 1 ? names[0] : "them";
    const them = names.length === 1 ? "it" : "them";
    return (
      `${subject} not connected for this team. Connect ${what} on the Integrations page and ` +
      `share ${them} with the team, then install this template.`
    );
  }
  return `${subject} not connected on your account. Connect ${names.length === 1 ? "it" : "them"} on the Integrations page, then install this template.`;
}

/** The card's control for a template the workspace cannot install yet. It
 * links to Integrations either way; the label names the work waiting there,
 * which in a team workspace is the sharing step. */
export function connectLabel(names: string[], teamId: string | undefined): string {
  const what = names.length === 1 ? names[0] : "integrations";
  return teamId === undefined ? `Connect ${what}` : `Share ${what} with the team`;
}
