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
 * words. `connected: false` is the caller's own gap and the caller can
 * close it on the integrations page. `unconfigured: true` is the
 * deployment's gap — the org has not set the service up — and only an
 * admin can close it. The integrations page hides an unconfigured service
 * (integration-availability design), so sending the reader there for one
 * is sending them to a page with nothing on it.
 */
import type { WorkflowTemplateRequirement } from "@valet/api/wire";
import { displayName } from "~/components/integrations/display-name";

/**
 * The services a template needs that the caller has not connected AND could
 * connect. An unconfigured service is excluded: no page offers it, so
 * naming it on a Connect button would send the reader nowhere.
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

/** True when every service this template needs is ready for this caller. */
export function isInstallable(requires: WorkflowTemplateRequirement[]): boolean {
  return missingServices(requires).length === 0 && unconfiguredServices(requires).length === 0;
}

/**
 * One sentence for the services an admin has to set up, worded like the
 * integrations page's own note so the two surfaces read the same.
 */
export function unconfiguredNote(names: string[]): string {
  const subject = names.length === 1 ? `${names[0]} is` : `${names.join(", ")} are`;
  return `${subject} not configured for this organization. An admin can set this up in Settings → Organization.`;
}

/**
 * One sentence for the services the caller can connect themselves, in the
 * shape the repo's error rule asks for: the fact, then the action.
 */
export function missingNote(names: string[]): string {
  const subject = names.length === 1 ? `${names[0]} is` : `${names.join(", ")} are`;
  return `${subject} not connected on your account. Connect ${names.length === 1 ? "it" : "them"} on the Integrations page, then install this template.`;
}
