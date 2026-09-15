/**
 * Environment hooks for the dag/v1 definition validator — closes the gap
 * between "definition is structurally valid" and "definition will actually
 * run": unknown model specs and unknown tool service/actions fail at SAVE
 * with an actionable message, instead of at run time inside a node.
 */
import { bundledModel } from "@valet/engine/model-catalog";
import type { ActionPlugin, ValetPlugin } from "@valet/engine";
import type { ValidateEnvironment } from "@valet/workflow";
import { buildOrgCatalog, openrouterRegistryIds, type CatalogEntry } from "../services/model-catalog.js";
import { parseModelId } from "../services/llm-providers.js";
import type { WorkflowServiceDeps } from "./service.js";
import { TIER_SET, TIER_TOKENS } from "../services/model-tiers.js";

/**
 * Mirrors `engine-deps.ts`'s `resolveWorkflowModel` matching rules:
 * `provider/model` form is looked up directly; a bare id is tried under
 * the common providers (anthropic first — the engine's own default
 * convention).
 */
export function isKnownModelSpec(spec: string): boolean {
  if (TIER_SET.has(spec.trim().toLowerCase())) return true;
  const slash = spec.indexOf("/");
  if (slash > 0) {
    const provider = spec.slice(0, slash);
    const modelId = spec.slice(slash + 1);
    return bundledModel(provider, modelId) != null;
  }
  return bareIdProvider(spec) !== undefined;
}

/** The providers `resolveWorkflowModel` probes for a bare id, in its order. */
const BARE_ID_PROVIDERS = ["anthropic", "openai", "google"] as const;

/**
 * The provider a bare (namespace-less) id reaches at run time. `llmComplete`
 * in `engine-deps.ts` probes the bundled catalogs in this order and takes the
 * first hit, so a bare id belongs to exactly one provider.
 */
function bareIdProvider(modelId: string): string | undefined {
  for (const provider of BARE_ID_PROVIDERS) {
    if (bundledModel(provider, modelId) != null) return provider;
  }
  return undefined;
}

/** What a member must do when the org set rejects their model. */
const MODEL_NOT_ALLOWED =
  "Choose a model that this organization approved and activated in Settings > Models, " +
  "or a size tier (xs, s, m, l, xl) that has an active provider.";

/**
 * The model ids a definition may name for one organization: every catalog
 * entry that is active AND approved, in both spellings the engine resolves,
 * plus the size tiers in `tiers` and the OpenRouter ids in `openrouterIds`
 * that the catalog's curated list leaves out.
 *
 * A bare id gets in under two rules, both of which mirror how the run
 * resolves it. A bare Anthropic id always resolves, because `parseModelId`
 * reads a missing namespace as Anthropic. A bare OpenAI or Google id
 * resolves only through the bundled probe in `engine-deps.ts`, and only
 * when that probe lands on the same provider — so an id that Anthropic also
 * bundles never enters under OpenAI or Google.
 */
function orgWorkflowModelIds(
  entries: CatalogEntry[],
  tiers: Iterable<string>,
  openrouterIds: Iterable<string>,
): Set<string> {
  const ids = new Set<string>(openrouterIds);
  for (const entry of entries) {
    if (!entry.active || !entry.approved) continue;
    ids.add(entry.id);
    const { namespace, modelId } = parseModelId(entry.id);
    if (namespace === "anthropic") ids.add(modelId);
    else if (namespace === "openai" || namespace === "google") {
      if (bareIdProvider(modelId) === namespace) ids.add(modelId);
    }
  }
  for (const tier of tiers) ids.add(tier);
  return ids;
}

/** Narrows a TypeBox schema (a plain object at runtime) without a cast. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildValidateEnvironment(
  actionPluginByService?: Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>,
  orgModelIds?: ReadonlySet<string>,
): ValidateEnvironment {
  return {
    // An org set REPLACES the bundled list. Accepting either one let a full
    // save keep a model the org disabled or never approved, which the
    // model-only update path rejects and the run then fails on.
    isKnownModel: (spec) => {
      if (!orgModelIds) return isKnownModelSpec(spec);
      // Tiers are case-insensitive at run time (`resolveModelSpec`), so a
      // definition that carries `L` must stay valid.
      const normalized = spec.trim().toLowerCase();
      const wanted = TIER_SET.has(normalized) ? normalized : spec;
      return orgModelIds.has(wanted) ? true : MODEL_NOT_ALLOWED;
    },
    isKnownAction: actionPluginByService
      ? (service, action) => {
          const entry = actionPluginByService.get(service);
          if (!entry) return "unknown-service";
          // Plugins with a dynamic action resolver (MCP-style) only know
          // their action list at runtime with credentials in hand — pass.
          if (entry.actionPlugin.resolveActions) return "dynamic";
          const qualified = `${service}.${action}`;
          const known = entry.actionPlugin.actions.some(
            (a) => a.id === qualified || a.id === action,
          );
          return known ? "ok" : "unknown-action";
        }
      : undefined,
    // The linter checks a tool node's params keys against this schema at
    // save time — `pull_number` for `pullNumber` used to pass the linter
    // and fail only inside the run, at the runtime ajv check.
    getActionParams: actionPluginByService
      ? (service, action) => {
          const entry = actionPluginByService.get(service);
          // Dynamic (MCP-style) plugins carry no static schemas — same
          // pass-through as isKnownAction's "dynamic".
          if (!entry || entry.actionPlugin.resolveActions) return undefined;
          const qualified = `${service}.${action}`;
          const found = entry.actionPlugin.actions.find(
            (a) => a.id === qualified || a.id === action,
          );
          const schema: unknown = found?.parameters;
          return isRecord(schema) ? schema : undefined;
        }
      : undefined,
  };
}

/** What building the org environment reads. Narrower than
 * `WorkflowServiceDeps` so a caller that holds no run host or store — the
 * template service — can build the same environment. */
export type OrgValidateDeps = Pick<WorkflowServiceDeps, "db" | "credentials" | "actionPluginByService">;

/**
 * The validator environment for one organization. Every definition that is
 * saved whole validates against this, so a full save accepts exactly the
 * models the model-only update path accepts.
 */
export async function buildOrgValidateEnvironment(
  deps: OrgValidateDeps,
  orgId: string,
): Promise<ValidateEnvironment> {
  const [catalog, openrouterIds] = await Promise.all([
    buildOrgCatalog(deps.db, deps.credentials, orgId),
    openrouterRegistryIds(deps.db, deps.credentials, orgId),
  ]);
  return buildValidateEnvironment(
    deps.actionPluginByService,
    orgWorkflowModelIds(catalog, TIER_TOKENS, openrouterIds),
  );
}
