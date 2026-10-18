/**
 * The onboarding empty state (docs/specs/2026-10-16-presence-hub-design.md
 * Part B step 9). A workspace with no place row and no routine sees, in
 * place of the overview's groups, where to start: **Add** to act on a
 * schedule, or connect a service to listen somewhere too. The overview's
 * header carries **Add**.
 */
import { Link } from "@tanstack/react-router";
import { usePresencePlaces } from "~/api/presence";
import { useWorkflowTriggers } from "~/api/workflows";
import { textLinkClass } from "~/components/primitives";
import { useListOwner } from "~/lib/use-list-owner";
import { isRoutine } from "./routine-helpers";

/** True once the places and the routines have loaded and both are empty.
 * While either loads, or after an error, it is false. Activity reads it to
 * offer its own Add. */
export function useNotPresentAnywhere(): boolean {
  const owner = useListOwner();
  const placesQ = usePresencePlaces();
  const triggersQ = useWorkflowTriggers(undefined, owner, { enabled: owner !== undefined });
  return placesQ.isSuccess && placesQ.data.places.length === 0
    && triggersQ.isSuccess && triggersQ.data.triggers.filter(isRoutine).length === 0;
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
