import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useEventSubscriptions } from "~/api/events";
import { useWorkflowTriggers } from "~/api/workflows";
import { AutomationWizard } from "~/components/events/automation-wizard";
import { ListenerRow, useListenerSentence } from "~/components/presence/listener-rows";
import { ProblemBadge } from "~/components/presence/problem-badge";
import { isRoutine, routineWhen, useRoutineSentence } from "~/components/presence/routines-tab";
import { Badge, Button, EmptyRow, ErrorRow, LoadingRow, WorkRow, WorkSection } from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { WebhookSection } from "./webhook-section";
import type { TriggerKind } from "./trigger-dialog";

/**
 * What starts one workflow, in the editor's side panel
 * (docs/specs/2026-10-16-presence-hub-design.md Part F step 2): the webhook
 * URL, then each listener and routine that runs it, as its Part C or Part D
 * sentence. A row opens the listener or routine page, where it is edited.
 * **Add** opens the wizard with this workflow as the target.
 *
 * `startNew` comes from the new-workflow dialog: the workflow was just
 * created to run on a schedule or on an event, so the wizard opens at once.
 */
export function TriggersPanel({ workflowId, startNew }: { workflowId: string; startNew?: TriggerKind }) {
  const triggersQ = useWorkflowTriggers(workflowId);
  const routines = (triggersQ.data?.triggers ?? []).filter(isRoutine);
  // A listener is an event rule whose target is this workflow. The rules
  // list carries the filters and the target the sentence reads.
  const subscriptionsQ = useEventSubscriptions();
  const listeners = (subscriptionsQ.data?.subscriptions ?? []).filter(
    (sub) => sub.target.kind === "workflow" && sub.target.workflowId === workflowId,
  );
  const listenerSentence = useListenerSentence(listeners);
  const routineSentence = useRoutineSentence(routines);
  // The flow the open wizard starts on, or null while it is closed.
  const [adding, setAdding] = useState<"listener" | "routine" | null>(
    startNew === "schedule" ? "routine" : startNew === "event" ? "listener" : null,
  );

  const pending = triggersQ.isPending || subscriptionsQ.isPending;
  const failed = triggersQ.error ?? subscriptionsQ.error;
  const empty = !pending && failed == null && listeners.length === 0 && routines.length === 0;

  return (
    <div className="space-y-6 px-4 py-3">
      <WebhookSection workflowId={workflowId} />
      <WorkSection
        title="Listeners and routines"
        actions={(
          <Button size="sm" variant="secondary" onClick={() => setAdding("listener")}>
            <Plus aria-hidden className="h-3.5 w-3.5" />
            Add
          </Button>
        )}
      >
        {pending && <LoadingRow className="px-4" />}
        {failed != null && (
          <ErrorRow className="px-4">{errorText(failed, "Could not load what runs this workflow. Reload the page to try again.")}</ErrorRow>
        )}
        {empty && (
          <EmptyRow className="px-4 py-3">
            Nothing starts this workflow yet. Select Add to run it when something happens or at a set time.
          </EmptyRow>
        )}
        {listeners.map((sub) => <ListenerRow key={sub.id} sub={sub} sentence={listenerSentence(sub)} />)}
        {routines.map((routine) => (
          <WorkRow
            key={routine.id}
            title={<Link to="/presence/routines" search={{ routine: routine.id }}>{routineSentence(routine)}</Link>}
            badge={(
              <>
                {!routine.enabled && <Badge variant="neutral">Off</Badge>}
                <ProblemBadge problem={routine.detail.disabledReason} />
              </>
            )}
            detail={routineWhen(routine)}
          />
        ))}
      </WorkSection>
      {adding !== null && (
        <AutomationWizard
          open
          onOpenChange={(open) => { if (!open) setAdding(null); }}
          preselectedWorkflowId={workflowId}
          startOn={adding}
        />
      )}
    </div>
  );
}
