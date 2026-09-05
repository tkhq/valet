import { and, eq, inArray } from "drizzle-orm";
import type { RepoPrebuildFlags } from "../bakes/source-service.js";
import type { AppDb } from "../lib/drizzle.js";
import type { PrebuildResources } from "../prebuilds/recipe.js";
import { imageSources } from "../schema/index.js";
import type { RepoBinding } from "../wire/types.js";

export interface ResolvedRepoPrebuildFlags extends RepoPrebuildFlags {
  /** Fresh compute can use these values even when existing compute must be preserved. */
  initialResources?: PrebuildResources;
  /** Settings exist, but one authority read failed, so reconciliation must preserve live resources. */
  resourcesWithheld?: boolean;
}

/** Read saved defaults outside the GitHub cache. Only two successful reads
 * authorize a resource change on existing compute. */
export async function resolveRepoResources(
  db: AppDb | undefined,
  orgId: string,
  primary: Pick<RepoBinding, "host" | "fullName"> | undefined,
  readYaml: () => Promise<RepoPrebuildFlags>,
): Promise<ResolvedRepoPrebuildFlags> {
  if (!primary) return { docker: false, outcome: "absent", resources: {} };
  const host = primary.host ?? "github";
  const hosts = host === "github" || host === "github.com" ? ["github", "github.com"] : [host];
  const readSaved = async (): Promise<{ ok: boolean; resources?: PrebuildResources }> => {
    if (!db) return { ok: false };
    try {
      const sources = await db.select({ host: imageSources.repoHost, resources: imageSources.sandboxResources })
        .from(imageSources)
        .where(and(
          eq(imageSources.kind, "repo"),
          eq(imageSources.orgId, orgId),
          inArray(imageSources.repoHost, hosts),
          eq(imageSources.repoFullName, primary.fullName),
        ))
        .limit(hosts.length);
      // The unique repo index permits one row per host spelling. An exact
      // row wins even when its saved defaults are empty.
      const source = sources.find((candidate) => candidate.host === host) ?? sources[0];
      return { ok: true, resources: source?.resources ?? {} };
    } catch (error) {
      console.error(`EngineHost: saved sandbox defaults lookup failed for ${orgId}/${primary.fullName}:`, error);
      return { ok: false };
    }
  };
  const [saved, yaml] = await Promise.all([readSaved(), readYaml()]);
  const { resources: yamlResources, ...flags } = yaml;
  const combined = { ...saved.resources, ...(yaml.outcome === "error" ? {} : yamlResources) };
  return {
    ...flags,
    ...(saved.ok && yaml.outcome !== "error" ? { resources: combined } : {}),
    ...(Object.keys(combined).length > 0 ? { initialResources: combined } : {}),
    ...(Object.keys(combined).length > 0 && (!saved.ok || yaml.outcome === "error") ? { resourcesWithheld: true } : {}),
  };
}
