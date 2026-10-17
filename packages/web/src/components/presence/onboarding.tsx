/**
 * The onboarding empty state (docs/specs/2026-10-16-presence-hub-design.md
 * Part C step 8). A workspace with no place and no routine sees, in the
 * Activity pane, where to start: connect a service, or add a routine. A
 * workspace with a place but no routine sees the Log; the Routines pane has
 * its own empty state.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { usePresencePlaces } from "~/api/presence";
import { useWorkflowTriggers } from "~/api/workflows";
import { cardClass } from "~/components/primitives";
import { TriggerDialog } from "~/components/workflows/trigger-dialog";
import { cn } from "~/lib/cn";
import { useListOwner } from "~/lib/use-list-owner";
import { isRoutine } from "./routines-pane";

/** True once the places and the routines (the rail's reads) have loaded and
 * both are empty. While either loads, or after an error, it is false, so
 * the Log shows. */
export function useNotPresentAnywhere(): boolean {
  const owner = useListOwner();
  const placesQ = usePresencePlaces();
  const triggersQ = useWorkflowTriggers(undefined, owner, { enabled: owner !== undefined });
  return placesQ.isSuccess && placesQ.data.places.length === 0
    && triggersQ.isSuccess && triggersQ.data.triggers.filter(isRoutine).length === 0;
}

const SERVICES = ["Slack", "GitHub", "Linear"] as const;

export function Onboarding() {
  const [creating, setCreating] = useState(false);
  return (
    <section aria-labelledby="presence-onboarding" className="space-y-4">
      <h3 id="presence-onboarding" className="text-base font-medium text-ink">Valet is not present anywhere yet.</h3>
      <ul className="grid gap-3 sm:grid-cols-3">
        {SERVICES.map((service) => (
          <li key={service}>
            <Link
              to="/integrations"
              className={cn(cardClass, "flex min-h-11 items-center px-4 py-3 text-sm text-ink transition-colors hover:border-muted")}
            >
              Connect {service}
            </Link>
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted">
        or{" "}
        <button type="button" className="text-ink underline-offset-2 hover:underline" onClick={() => setCreating(true)}>
          add a routine
        </button>
      </p>
      {creating && <TriggerDialog open onOpenChange={setCreating} schedulesOnly />}
    </section>
  );
}
