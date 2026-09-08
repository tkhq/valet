import { and, eq, inArray } from "drizzle-orm";
import type { RepoPrebuildFlags } from "../bakes/source-service.js";
import type { AppDb } from "../lib/drizzle.js";
import type { PrebuildResources } from "../prebuilds/recipe.js";
import { imageSources } from "../schema/index.js";
import type { RepoBinding } from "../wire/types.js";

type ResourceField = keyof Pick<PrebuildResources, "cpu" | "memory">;
const RESOURCE_FIELDS: readonly ResourceField[] = ["cpu", "memory"];

export interface ResolvedRepoPrebuildFlags extends RepoPrebuildFlags {
  /** Fresh compute can use these values even when existing compute must be preserved. */
  initialResources?: PrebuildResources;
  /** A repository authority read failed, so reconciliation must preserve live resources. */
  resourcesWithheld?: boolean;
  /** Live fields to preserve because repository authority was unavailable. */
  preserveResourceFields?: readonly ResourceField[];
}

/** Apply one child's resource request after repository and saved defaults.
 * When authority reads fail, only supplied fields become authoritative. */
export function applySandboxResourceOverrides(
  flags: ResolvedRepoPrebuildFlags,
  overrides: PrebuildResources | undefined,
): ResolvedRepoPrebuildFlags {
  if (!overrides || Object.keys(overrides).length === 0) return flags;
  // A partial desired resource object resets omitted fields on adoption unless
  // the engine carries a preservation mask. When repository authority is
  // unavailable, task-supplied fields stay authoritative and omitted fields
  // preserve the CR's live values. Fresh compute uses every available default.
  const unavailableFields = flags.preserveResourceFields ??
    (flags.resourcesWithheld ? RESOURCE_FIELDS : undefined);
  if (unavailableFields) {
    const preserveResourceFields = unavailableFields.filter((field) => overrides[field] === undefined);
    return {
      ...flags,
      initialResources: { ...flags.initialResources, ...overrides },
      resources: { ...overrides },
      preserveResourceFields,
    };
  }
  return {
    ...flags,
    initialResources: { ...flags.initialResources, ...overrides },
    resources: { ...flags.resources, ...overrides },
  };
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
    ...(!saved.ok || yaml.outcome === "error"
      ? { resourcesWithheld: true, preserveResourceFields: RESOURCE_FIELDS }
      : {}),
  };
}
