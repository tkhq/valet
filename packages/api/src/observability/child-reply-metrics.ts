/**
 * Durable child-reply delivery failures and long waits ("Invariants: alert,
 * don't auto-repair"). Every intent ends completed or failed. A rising
 * `terminal` count means channel replies are being lost and needs a human.
 * A long wait is not repaired: the intent stays open and is counted once
 * per process, because a parent update that never arrives needs a human.
 */
import { metrics } from "@opentelemetry/api";

type Counter = ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
let failureCounter: Counter | undefined;
let overAgeCounter: Counter | undefined;

export function recordChildReplyFailure(terminal: boolean): void {
  failureCounter ??= metrics.getMeter("@valet/api").createCounter("valet.channels.child_reply.failures", {
    description: "Failed child-reply delivery attempts; terminal=true when the intent stops retrying",
  });
  failureCounter.add(1, { terminal: String(terminal) });
}

export function recordChildReplyOverAgeWait(): void {
  overAgeCounter ??= metrics.getMeter("@valet/api").createCounter("valet.channels.child_reply.over_age_waits", {
    description: "Child-reply intents still waiting for their parent update past the report age",
  });
  overAgeCounter.add(1);
}
