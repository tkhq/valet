/**
 * Per-org sandbox capacity gate (incident recommendation D.5): sandbox
 * slots are a bounded resource, and the engine previously scheduled
 * fan-out as if they were infinite — a single 10-minute cron with an
 * 11-way foreach demanded ~66 slots/hour of a cluster with ~28 free, and
 * nothing noticed until the scheduler saturated.
 *
 * `withSandboxCapacityGate` wraps the built `SandboxProvider`: `create()`
 * admits only while the org's live-sandbox count (ready attachments in
 * the host cache + this gate's admitted-but-not-yet-ready creates) is
 * under the ceiling. Over the ceiling, the create WAITS — the owning
 * attachment shows `provisioning`, and the wait is logged and measured —
 * up to the configured window, then fails terminally with the cause and
 * the corrective action.
 *
 * Scope and known limits (spec "Deviations"):
 *   - The count is this process's view (host cache + local in-flight
 *     set). Sandboxes surviving a restart are re-counted only once their
 *     sessions re-cache; the fan-out bursts this gate exists to stop are
 *     in-process phenomena, so the window is acceptable.
 *   - `resume()` (hibernation wake) is not gated — a wake re-occupies a
 *     slot the org already consumed once. Deferred.
 *   - Admission order among waiters is poll-based, not FIFO.
 */
import { recordSandboxCapacityWait, SandboxStartupError, type SandboxProvider } from "@valet/engine";

const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** The slice of `EngineHost` the gate reads. Late-bound (the provider is
 * constructed before the host); a null host admits without gating. */
export interface CapacityGateHost {
  sessionOrgId(sessionId: string): string | null;
  countReadySandboxSessions(orgId: string): number;
}

export interface SandboxCapacityGateOpts {
  /** Max concurrent live sandboxes per org (`VALET_ORG_SANDBOX_CEILING`);
   * `<= 0` disables the gate entirely. */
  ceiling: number;
  /** How long an over-ceiling create waits before failing terminally
   * (`VALET_SANDBOX_CAPACITY_WAIT_MINUTES`); `0` fails fast. */
  waitMs: number;
  host: () => CapacityGateHost | null;
  /** Override for tests. */
  pollIntervalMs?: number;
}

export function withSandboxCapacityGate(
  inner: SandboxProvider,
  opts: SandboxCapacityGateOpts,
): SandboxProvider {
  if (opts.ceiling <= 0) return inner;
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  /** Admitted creates not yet visible as `ready` in the host cache, by org. */
  const inFlight = new Map<string, number>();

  const admitted = (orgId: string): number => inFlight.get(orgId) ?? 0;
  const bump = (orgId: string, delta: number): void => {
    const next = admitted(orgId) + delta;
    if (next <= 0) inFlight.delete(orgId);
    else inFlight.set(orgId, next);
  };

  async function admit(sessionId: string | undefined): Promise<string | null> {
    const host = opts.host();
    if (!host) return null; // pre-boot create: nothing to count against yet
    const orgId = sessionId ? host.sessionOrgId(sessionId) : null;
    if (!orgId) {
      // Not a session-owned create (conformance tests, ad-hoc tooling) —
      // there is no org to bill the slot to. Admit; the reconcile sweep's
      // unowned report covers anything that leaks from here.
      return null;
    }
    const startedAt = Date.now();
    const deadline = startedAt + opts.waitMs;
    let waiting = false;
    for (;;) {
      const live = host.countReadySandboxSessions(orgId) + admitted(orgId);
      if (live < opts.ceiling) {
        bump(orgId, 1);
        if (waiting) recordSandboxCapacityWait(Date.now() - startedAt, "admitted");
        return orgId;
      }
      if (Date.now() >= deadline) {
        recordSandboxCapacityWait(Date.now() - startedAt, "timeout");
        throw new SandboxStartupError(
          sessionId ?? "sandbox",
          `org sandbox ceiling reached (${opts.ceiling} concurrent). ` +
            `Waited ${Math.round((Date.now() - startedAt) / 1000)}s for capacity. ` +
            "Finish or pause other sessions, or raise VALET_ORG_SANDBOX_CEILING.",
        );
      }
      if (!waiting) {
        waiting = true;
        console.log(
          `SandboxCapacityGate: org ${orgId} is at its sandbox ceiling (${opts.ceiling}); ` +
            `session ${sessionId} is waiting for capacity`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  // Hand-built member by member: optional members must keep their ABSENCE
  // (capability code gates on `provider.updateCreds`/`deriveId`/`list`
  // presence), so a class implementing the full interface would lie.
  const gated: SandboxProvider = {
    backend: inner.backend,
    capabilities: () => inner.capabilities(),
    create: async (createOpts) => {
      const orgId = await admit(createOpts.sessionId);
      try {
        return await inner.create(createOpts);
      } finally {
        // The slot handed to this create is now either visible as a
        // `ready` attachment (success, moments after create resolves) or
        // free again (failure). Either way the in-flight hold ends.
        if (orgId) bump(orgId, -1);
      }
    },
    restore: (id) => inner.restore(id),
    destroy: (id) => inner.destroy(id),
    status: (id) => inner.status(id),
  };
  if (inner.release) gated.release = inner.release.bind(inner);
  if (inner.deriveId) gated.deriveId = inner.deriveId.bind(inner);
  if (inner.list) gated.list = inner.list.bind(inner);
  if (inner.suspend) gated.suspend = inner.suspend.bind(inner);
  if (inner.resume) gated.resume = inner.resume.bind(inner);
  if (inner.updateCreds) gated.updateCreds = inner.updateCreds.bind(inner);
  return gated;
}
