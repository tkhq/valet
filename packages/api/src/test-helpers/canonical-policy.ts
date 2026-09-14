import type { ValetPlugin } from "@valet/engine";
import { eq } from "drizzle-orm";
import { CanonicalAuthorizationService } from "../authorization/canonical-authorization-service.js";
import { CanonicalPolicyBundleManager } from "../authorization/canonical-policy-manager.js";
import type { AppDb } from "../lib/drizzle.js";
import { assemblePlugins } from "../plugins/assemble.js";
import { orgs } from "../schema/index.js";

export async function canonicalPolicyForTest(
  db: AppDb,
  organizationId: string,
  plugins: ValetPlugin[] = [],
) {
  const { actionPluginByService } = assemblePlugins([plugins]);
  const manager = new CanonicalPolicyBundleManager(db, actionPluginByService);
  const organization = await db
    .select({ id: orgs.id })
    .from(orgs)
    .where(eq(orgs.id, organizationId))
    .limit(1);
  if (organization[0]) await manager.ensureOrganizationReady(organizationId);
  else await manager.provisionOrganization(organizationId);
  return {
    manager,
    actionPluginByService,
    canonicalAuthorizationService: await CanonicalAuthorizationService.create(manager),
  };
}
