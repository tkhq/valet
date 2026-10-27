export { SOURCE_HEALTH_GUIDANCE, sourceHealthGuidance, sourceHealthPhrase, type SourceHealth, type SourceHealthReason } from "@valet/shared";
import type { SourceHealth } from "@valet/shared";

export const HEALTH_TONE: Record<SourceHealth, "success" | "current" | "warning" | "danger" | "neutral"> = {
  healthy: "success", stale: "current", incompatible: "warning", failing: "danger", unbaked: "neutral",
};
export const HEALTH_ORDER: Record<SourceHealth, number> = { failing: 0, incompatible: 1, unbaked: 2, stale: 3, healthy: 4 };
