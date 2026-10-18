/**
 * The onboarding empty state (docs/specs/2026-10-16-presence-hub-design.md
 * Part B step 9). A workspace with no place row and no routine sees, in
 * place of the overview's groups, where to start: **Add** to act on a
 * schedule, or connect a service to listen somewhere too. Activity shows it
 * as well, with its own **Add**.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { usePresencePlaces } from "~/api/presence";
import { useWorkflowTriggers } from "~/api/workflows";
import { AutomationWizard } from "~/components/events/automation-wizard";
import { Plus } from "lucide-react";
import { Button, textLinkClass } from "~/components/primitives";
import { useListOwner } from "~/lib/use-list-owner";
import { isRoutine } from "./routines-pane";

/** True once the places and the routines have loaded and
 * both are empty. While either loads, or after an error, it is false, so
 * the Log shows. */
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
 * header carries **Add**. A page without that header passes `withAdd`, so
 * the paragraph's Add exists on the page.
 */
export function Onboarding({ withAdd = false }: { withAdd?: boolean }) {
  const [creating, setCreating] = useState(false);
  return (
    <section aria-label="Getting started" className="max-w-prose">
      <p className="text-base text-ink">Valet is not present anywhere yet.</p>
      <p className="mt-4 text-[15px] text-muted">
        Choose Add to have Valet act on a schedule. To have it listen somewhere too, connect{" "}
        <Link to="/integrations" className={textLinkClass}>Slack</Link>,{" "}
        <Link to="/integrations" className={textLinkClass}>GitHub</Link>, or{" "}
        <Link to="/integrations" className={textLinkClass}>Linear</Link> and Add again.
      </p>
      {withAdd && (
        <Button className="mt-4" onClick={() => setCreating(true)}>
          <Plus aria-hidden className="h-3.5 w-3.5" />
          Add
        </Button>
      )}
      {creating && <AutomationWizard open onOpenChange={setCreating} />}
    </section>
  );
}
