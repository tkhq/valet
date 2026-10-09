import { isScratchRequestError, validateScratchRequest, type ScratchCaps } from "@valet/shared";
import { recordScratchRefused } from "@valet/engine";
import type { PrebuildResources } from "../prebuilds/recipe.js";
import type { ResolvedRepoPrebuildFlags } from "./resolve-repo-resources.js";

/** Drops the `scratch` key from a resource map when it is present. */
function dropScratch(resources: PrebuildResources | undefined): PrebuildResources | undefined {
  if (!resources || resources.scratch === undefined) return resources;
  const { scratch: _scratch, ...rest } = resources;
  return rest;
}

/**
 * Applies the deploy scratch cap to a repository's `.valet/prebuild.yaml`
 * declaration. A repo-declared `scratch` above the cap (or scratch disabled
 * entirely) is DROPPED, never clamped (spec INV-4: refuse, don't repair).
 * The repo keeps every other declared resource. `source: "prebuild"` applies
 * only the deploy cap; the agent cap is `task`-only and already enforced on
 * the spawner's own override (Task 13).
 */
export function applyScratchCaps(
  flags: ResolvedRepoPrebuildFlags,
  caps: ScratchCaps,
): { flags: ResolvedRepoPrebuildFlags; warning?: string } {
  const scratch = flags.resources?.scratch;
  if (scratch === undefined) return { flags };
  try {
    validateScratchRequest(scratch, "prebuild", caps);
    return { flags };
  } catch (err) {
    if (!isScratchRequestError(err)) throw err;
    recordScratchRefused("prebuild", err.reason);
    return {
      flags: {
        ...flags,
        resources: dropScratch(flags.resources),
        initialResources: dropScratch(flags.initialResources),
      },
      warning: `Valet did not apply the repository's scratch setting. ${err.message}`,
    };
  }
}
