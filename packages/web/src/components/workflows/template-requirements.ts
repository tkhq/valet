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
    .filter((r) => !r.connected && r.unconfigured !== true && !r.organizationProvided)
    .map((r) => displayName(r.service));
}

/** The services this organization has not set up. Only an admin can act. */
export function unconfiguredServices(requires: WorkflowTemplateRequirement[]): string[] {
  return requires.filter((r) => r.unconfigured === true).map((r) => displayName(r.service));
}

export function isInstallable(requires: WorkflowTemplateRequirement[], blockers: string[] = []): boolean {
  return blockers.length === 0 && requires.every((requirement) => requirement.connected && !requirement.unconfigured);
}

/** One sentence for the services an admin has to set up, worded like the
 * integrations page's own note. The org answers this the same way for every
 * workspace, so it takes no team id. */
export function unconfiguredNote(names: string[]): string {
  const subject = names.length === 1 ? `${names[0]} is` : `${names.join(", ")} are`;
  return `${subject} not configured for this organization. An admin can set this up in Settings → Organization.`;
}

/** Explain the missing connection in the active workspace. */
export function missingNote(names: string[], teamId: string | undefined): string {
  const subject = names.length === 1 ? `${names[0]} is` : `${names.join(", ")} are`;
  if (teamId !== undefined) {
    return `${subject} not connected for this team. Set up access on the Integrations page, then install this template.`;
  }
  return `${subject} not connected on your account. Connect ${names.length === 1 ? "it" : "them"} on the Integrations page, then install this template.`;
}

/** Link to setup without requiring personal credential sharing. */
export function connectLabel(names: string[], teamId: string | undefined): string {
  const what = names.length === 1 ? names[0] : "integrations";
  return teamId === undefined ? `Connect ${what}` : `Set up ${what} access`;
}

/** Name the authority without claiming the team holds a credential. */
export function requirementLabel(requirement: WorkflowTemplateRequirement): string {
  const name = requirement.service === "github" && requirement.organizationProvided
    ? "Organization GitHub App" : displayName(requirement.service);
  if (requirement.repositoryCheckOnInstall) return `${name} · repository access checked on install`;
  return requirement.organizationProvided ? `${name} · organization access` : name;
}

/** Missing App access is configured in organization settings, not Integrations. */
export function needsOrganizationGithubSetup(requires: WorkflowTemplateRequirement[]): boolean {
  return requires.some((requirement) => requirement.service === "github" &&
    !requirement.connected && requirement.organizationProvided === true);
}
