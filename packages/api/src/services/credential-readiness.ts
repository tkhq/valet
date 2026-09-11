/** Refresh every team whose readiness can change after a credential write. */
import type { CredentialOwner } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import type { ContentSyncService } from "./content-sync/service.js";
import { listDelegationsFrom } from "./credential-delegations.js";

export async function refreshCredentialReadiness(
  deps: { db: AppDb; contentSync: ContentSyncService },
  owner: CredentialOwner,
  service: string,
): Promise<void> {
  if (owner.type === "org") {
    await deps.contentSync.resyncOrgWorkflowSources(owner.id);
  } else if (owner.type === "team") {
    await deps.contentSync.resyncTeamWorkflowSources(owner.id);
  } else if (owner.type === "user") {
    for (const teamId of new Set(await listDelegationsFrom(deps.db, { userId: owner.id, service }))) {
      await deps.contentSync.resyncTeamWorkflowSources(teamId);
    }
  }
}
