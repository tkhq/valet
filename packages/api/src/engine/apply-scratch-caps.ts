import { isScratchRequestError, parseResourceQuantity, validateScratchRequest, type ScratchCaps } from "@valet/shared";
import { recordScratchRefused, recordScratchRequested } from "@valet/engine";
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
  // `resources` is absent when a resource authority read failed; the repo's
  // request then lives only in `initialResources`, which the fresh-create
  // path still applies. The cap covers both (PR review, finding 2).
  const scratch = flags.resources?.scratch ?? flags.initialResources?.scratch;
  if (scratch === undefined) return { flags };
  try {
    const accepted = validateScratchRequest(scratch, "prebuild", caps);
    recordScratchRequested("repo", parseResourceQuantity(accepted) ?? 0);
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
      warning: `Valet did not apply resources.scratch from .valet/prebuild.yaml. ${err.message}`,
    };
  }
}
