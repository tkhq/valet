/**
 * The digest a claimed waiter recovers when its claim delivery never lands
 * (spec 2026-10-16: delivery threads and claims, Part C step 7).
 *
 * Ingest suppresses the digest of the waiter that a claim redirect targets,
 * because the delivery carries the event to that thread. The dispatcher can
 * still skip that delivery for a reason that came after ingest: a team rule
 * now covers it (`hasTeamCoverage`), or the rule was disabled. Without this
 * step the waiter would never see the event.
 */
import type { EventMatchDigest, NormalizedEvent } from "@valet/engine";
import { slackEventChannel } from "../services/thread-access.js";
import { conversationalTwinOf } from "./ingest.js";
import { anyMatch, matchClauses, toDigest } from "./waiter-match.js";
import type { WaiterMatchDeps } from "./waiters.js";

/**
 * Appends the event's digest to a waiter that a skipped claim delivery
 * named (`matchedWaiterId` or `suppressedWaiterIds`), in once or stream
 * mode, then nudges the WakeWatcher. The waiter's own clauses pick the
 * digest: the event, or its conversational twin when only the twin
 * matches (a mention claimed by a `slack.message` waiter).
 * Returns true when the waiter got a new digest. A waiter that ended, moved
 * to another org, or can no longer read the Slack channel gets none.
 */
export async function appendClaimedWaiterDigest(
  deps: WaiterMatchDeps,
  args: { waiterId: string; orgId: string; service: string; event: NormalizedEvent },
): Promise<boolean> {
  const waiter = await deps.engineStore.getWakeup(args.waiterId);
  const spec = waiter?.eventMatch;
  if (!waiter || !spec || waiter.kind !== "event" || waiter.status !== "running") return false;
  const owner = await deps.sessionOrg(waiter.sessionId);
  if (!owner || owner.orgId !== args.orgId) return false;
  if (args.service === "slack") {
    const channel = slackEventChannel({ service: args.service, refs: args.event.refs, payload: args.event.payload });
    if (!channel || !(await deps.slackStillVisible({ sessionId: waiter.sessionId, ...owner }, channel))) return false;
  }
  const derived = deps.plugins.flatMap((plugin) => plugin.derivedEvents ?? []);
  const twin = await conversationalTwinOf(deps.plugins, deps, args.orgId, args.service, args.event);
  for (const candidate of twin ? [args.event, twin] : [args.event]) {
    const result = matchClauses(spec, candidate, derived);
    if (!anyMatch(result)) continue;
    const digests: EventMatchDigest[] = [
      ...(result.direct ? [toDigest(candidate)] : []),
      ...result.derive.map((key) => toDigest(candidate, key)),
    ];
    let appended = false;
    for (const digest of digests) {
      if (await deps.engineStore.appendEventMatch(waiter.id, digest, deps.now())) appended = true;
    }
    if (appended) deps.nudge?.([waiter.id]);
    return appended;
  }
  return false;
}
