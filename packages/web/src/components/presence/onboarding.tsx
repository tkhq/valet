/**
 * The onboarding empty state (docs/specs/2026-10-16-presence-hub-design.md
 * Part B step 9). A workspace with no place row and no routine sees, in
 * place of the overview's groups, where to start: **Add** to act on a
 * schedule, or connect a service to listen somewhere too. The overview's
 * header carries **Add**.
 */
import { Link } from "@tanstack/react-router";
import type { EventSubscriptionWire, PresencePlaceWire, WorkflowTriggerItem } from "@valet/api/wire";
import { useEventSubscriptions } from "~/api/events";
import { usePresencePlaces } from "~/api/presence";
import { useWorkflowTriggers } from "~/api/workflows";
import { textLinkClass } from "~/components/primitives";
import { useListOwner } from "~/lib/use-list-owner";
import { overviewGroups } from "./overview-groups";
import { isRoutine } from "./routine-helpers";

/** True when the workspace has no place row and no routine (spec Part B step 9). */
export function overviewEmpty(
  places: readonly PresencePlaceWire[],
  lines: readonly EventSubscriptionWire[],
  triggers: readonly WorkflowTriggerItem[],
): boolean {
  return overviewGroups(places, lines, new Set()).length === 0 && !triggers.some(isRoutine);
}

/** True once the places, the lines, and the routines have loaded and the
 * overview has no place row and no routine (`overviewEmpty`). A place that
 * only threads or events touched is no row. While a read loads, or after an
 * error, it is false. Activity reads it to offer its own Add. */
export function useNotPresentAnywhere(): boolean {
  const owner = useListOwner();
  const enabled = owner !== undefined;
  const placesQ = usePresencePlaces();
  const linesQ = useEventSubscriptions(owner, { enabled });
  const triggersQ = useWorkflowTriggers(undefined, owner, { enabled });
  return placesQ.isSuccess && linesQ.isSuccess && triggersQ.isSuccess
    && overviewEmpty(placesQ.data.places, linesQ.data.subscriptions, triggersQ.data.triggers);
}

/**
 * The empty state: `Valet is not present anywhere yet.` and one paragraph
 * with Slack, GitHub, and Linear as links to Integrations. The overview's
 * header carries **Add**.
 */
export function Onboarding() {
  return (
    <section aria-label="Getting started" className="max-w-prose">
      <p className="text-base text-ink">Valet is not present anywhere yet.</p>
      <p className="mt-4 text-[15px] text-muted">
        Choose Add to have Valet act on a schedule. To have it listen somewhere too, connect{" "}
        <Link to="/integrations" className={textLinkClass}>Slack</Link>,{" "}
        <Link to="/integrations" className={textLinkClass}>GitHub</Link>, or{" "}
        <Link to="/integrations" className={textLinkClass}>Linear</Link> and Add again.
      </p>
    </section>
  );
}
