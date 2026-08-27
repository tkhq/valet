/**
 * Per-org sandbox capacity gate (incident recommendation D.5): sandbox
 * slots are a bounded resource, and the engine previously scheduled
 * fan-out as if they were infinite — a single 10-minute cron with an
 * 11-way foreach demanded ~66 slots/hour of a cluster with ~28 free, and
 * nothing noticed until the scheduler saturated.
 *
 * `withSandboxCapacityGate` wraps the built `SandboxProvider`. `create()`
 * admits only while the org's occupied-slot count is under the ceiling.
 * Over the ceiling, the create WAITS — the owning attachment shows
 * `provisioning`, and the wait is logged and measured — up to the
 * configured window, then fails terminally with the cause and the
 * corrective action.
 *
 * ## Counting
 *
 * A slot is occupied by every cached session of the org whose attachment
 * is `provisioning` or `ready`, MINUS the sessions currently parked at
 * this gate (their attachments already read `provisioning`, but they hold
 * no pod yet — counting them would deadlock a burst against itself). An
 * admitted create leaves the waiting set and stays counted through
 * `provider.create` AND the post-create prep window (clone, steps) until
 * the attachment leaves `ready` — there is no moment where a live pod is
 * invisible to the count. A failed provision drops the attachment to
 * `error`, freeing the slot.
 *
 * Scope and known limits (spec "Deviations"):
 *   - The count is this process's cache view. Sandboxes surviving a
 *     restart re-count once their sessions re-cache; fan-out bursts are
 *     in-process, so the window is acceptable.
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
  countLiveSandboxSessions(orgId: string): number;
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
  /** Sessions currently parked in `admit`'s poll loop, by org — subtracted
   * from the cache count (see the counting doc above). */
  const waitingByOrg = new Map<string, Set<string>>();

  const waitingSet = (orgId: string): Set<string> => {
    let set = waitingByOrg.get(orgId);
    if (!set) {
      set = new Set();
      waitingByOrg.set(orgId, set);
    }
    return set;
  };

  async function admit(sessionId: string | undefined): Promise<void> {
    const host = opts.host();
    if (!host) return; // pre-boot create: nothing to count against yet
    if (!sessionId) return; // not a session-owned create (conformance tests, tooling)
    const orgId = host.sessionOrgId(sessionId);
    if (!orgId) return; // uncached: not billable to an org from here
    const startedAt = Date.now();
    const deadline = startedAt + opts.waitMs;
    const waiting = waitingSet(orgId);
    waiting.add(sessionId);
    try {
      let waited = false;
      for (;;) {
        // Subtract only waiters still resolvable in the cache: a waiter
        // whose session was destroyed/evicted mid-wait is already gone
        // from the count, and subtracting its stale waiting entry too
        // would over-free a slot and admit past the ceiling until its own
        // next poll notices.
        let liveWaiters = 0;
        for (const id of waiting) {
          if (host.sessionOrgId(id) !== null) liveWaiters += 1;
        }
        const occupied = host.countLiveSandboxSessions(orgId) - liveWaiters;
        if (occupied < opts.ceiling) {
          if (waited) recordSandboxCapacityWait(Date.now() - startedAt, "admitted");
          return;
        }
        if (Date.now() >= deadline) {
          recordSandboxCapacityWait(Date.now() - startedAt, "timeout");
          throw new SandboxStartupError(
            sessionId,
            `org sandbox ceiling reached (${opts.ceiling} concurrent). ` +
              `Waited ${Math.round((Date.now() - startedAt) / 1000)}s for capacity. ` +
              "Finish or pause other sessions, or raise VALET_ORG_SANDBOX_CEILING.",
          );
        }
        if (!waited) {
          waited = true;
          console.log(
            `SandboxCapacityGate: org ${orgId} is at its sandbox ceiling (${opts.ceiling}); ` +
              `session ${sessionId} is waiting for capacity`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        // A session destroyed or evicted while waiting must not consume
        // the next freed slot for a pod nobody will use.
        if (host.sessionOrgId(sessionId) === null) {
          throw new Error(
            `sandbox create abandoned: session ${sessionId} left the host cache while waiting for capacity. ` +
              "Reopen the session and retry.",
          );
        }
      }
    } finally {
      waiting.delete(sessionId);
      if (waiting.size === 0) waitingByOrg.delete(orgId);
    }
  }

  // Hand-built member by member: optional members must keep their ABSENCE
  // (capability code gates on `provider.updateCreds`/`deriveId`/`list`
  // presence), so a class implementing the full interface would lie.
  const gated: SandboxProvider = {
    backend: inner.backend,
    capabilities: () => inner.capabilities(),
    create: async (createOpts) => {
      await admit(createOpts.sessionId);
      return inner.create(createOpts);
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
