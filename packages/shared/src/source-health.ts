export type SourceHealthReason =
  | "ok" | "resolve_failed" | "repo_unreachable" | "credentials" | "registry_full"
  | "bake_failed" | "contract" | "contract_unknown" | "waiting_for_base";
export const SOURCE_HEALTH_GUIDANCE: Record<Exclude<SourceHealthReason, "ok">, string> = {
  resolve_failed: "Valet could not read the repo's recipe or lockfile. Usually a platform bug; the detail names the file.",
  repo_unreachable: "The Valet GitHub app lost access. Reinstall it on this repository.",
  credentials: "Anonymous bakes are off for this org. Connect an org GitHub credential.",
  registry_full: "The image registry is out of space. Retention needs to run.",
  bake_failed: "The setup commands failed. The log tail shows where.",
  contract: "The image was built before a runtime change. A rebuild is already queued.",
  contract_unknown: "Valet could not read the image's label from the registry. It will retry.",
  waiting_for_base: "The base image is building first. Nothing to do.",
};
export function sourceHealthGuidance(reason: SourceHealthReason): string | null {
  return reason === "ok" ? null : SOURCE_HEALTH_GUIDANCE[reason];
}
