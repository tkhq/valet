/** Rejected credentials presented while a session still owns a sandbox. */
import { metrics } from "@opentelemetry/api";

type Counter = ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
let rejectedCounter: Counter | undefined;

export function recordSandboxTokenRejected(reason: "revoked" | "expired"): void {
  rejectedCounter ??= metrics.getMeter("@valet/api").createCounter("valet.sandbox.token_rejected", {
    description: "Known credentials rejected while the session still has a sandbox",
  });
  rejectedCounter.add(1, { reason });
}
