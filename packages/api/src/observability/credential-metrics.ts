/**
 * Native credential policy fallbacks
 * (docs/specs/2026-10-15-native-integration-credential-policy-design.md).
 *
 * A native integration falls back to its app identity when no person's
 * credential applies. A broken team share or a dead team connection then
 * keeps working through the app, so nothing else shows that the delegated
 * credential needs repair. This counter shows it: alert on a rising
 * `dead_delegated` rate instead of letting the app token hide it.
 *
 * The OTel name `valet.credentials.app_fallback` exports to Prometheus as
 * `valet_credentials_app_fallback_total`. Same lazy meter shape as
 * `sandbox-token-metrics.ts`.
 */
import { metrics } from "@opentelemetry/api";

/** Why a read ended at the app token. */
export type AppFallbackReason =
  /** A user-owned read found no personal credential. */
  | "no_personal"
  /** A team-owned read found no share and no team connection. */
  | "no_delegated"
  /** A team share or team connection existed but could not answer. */
  | "dead_delegated"
  /** A member's share would answer, and that member has not approved yet. */
  | "approval_pending"
  /** An org-owned read, which has no person to act as. */
  | "org_owner";

type Counter = ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
let fallbackCounter: Counter | undefined;

export function recordAppCredentialFallback(service: string, reason: AppFallbackReason): void {
  fallbackCounter ??= metrics.getMeter("@valet/api").createCounter("valet.credentials.app_fallback", {
    description: "Native integration actions whose credential read ended at the app token",
  });
  fallbackCounter.add(1, { service, reason });
}
