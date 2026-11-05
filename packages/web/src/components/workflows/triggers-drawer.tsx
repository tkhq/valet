import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useEventSubscriptions } from "~/api/events";
import { useWorkflowTriggers } from "~/api/workflows";
import { LineEditor } from "~/components/presence/editor/line-editor";
import { PresenceRow, usePresenceSentence } from "~/components/presence/presence-rows";
import { ProblemBadge } from "~/components/presence/problem-badge";
import { isRoutine, routineWhen, useRoutineSentence } from "~/components/presence/routine-helpers";
import { Badge, Button, EmptyRow, ErrorRow, LoadingRow, WorkRow, WorkSection } from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { WebhookSection } from "./webhook-section";

/** What a new workflow was made to run on: a schedule or an event. */
export type TriggerKind = "schedule" | "event";

/**
 * What starts one workflow, in the editor's side panel
 * (docs/specs/2026-10-16-presence-hub-design.md Part F step 2): the webhook
 * URL, then each line and routine that runs it, as its Part C or Part D
 * sentence. A row opens the line's or the routine's page, where it is edited.
 * **Add** opens the editor fixed on this workflow as the target, so the
 * new line or routine shows in this panel.
 *
 * `startNew` comes from the new-workflow dialog: the workflow was just
 * created to run on a schedule or on an event, so the editor opens at once.
 */
export function TriggersPanel({ workflowId, startNew }: { workflowId: string; startNew?: TriggerKind }) {
  const triggersQ = useWorkflowTriggers(workflowId);
  const routines = (triggersQ.data?.triggers ?? []).filter(isRoutine);
  // A line here is one whose target is this workflow. The rules
  // list carries the filters and the target the sentence reads.
  const subscriptionsQ = useEventSubscriptions();
  const lines = (subscriptionsQ.data?.subscriptions ?? []).filter(
    (sub) => sub.target.kind === "workflow" && sub.target.workflowId === workflowId,
  );
  const presenceSentence = usePresenceSentence(lines);
  const routineSentence = useRoutineSentence(routines);
  // What the open editor starts on, or null while it is closed.
  const [adding, setAdding] = useState<"event" | "routine" | null>(
    startNew === "schedule" ? "routine" : startNew === "event" ? "event" : null,
  );

  const pending = triggersQ.isPending || subscriptionsQ.isPending;
  const failed = triggersQ.error ?? subscriptionsQ.error;
  const empty = !pending && failed == null && lines.length === 0 && routines.length === 0;

  return (
    <div className="space-y-6 px-4 py-3">
      <WebhookSection workflowId={workflowId} />
      <WorkSection
        title="What starts it"
        actions={(
          <Button size="sm" variant="secondary" onClick={() => setAdding("event")}>
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
        {lines.map((sub) => <PresenceRow key={sub.id} sub={sub} sentence={presenceSentence(sub)} />)}
        {routines.map((routine) => (
          <WorkRow
            key={routine.id}
            title={<Link to="/presence/routines/$id" params={{ id: routine.id }}>{routineSentence(routine)}</Link>}
            badge={(
              <>
                {!routine.enabled && <Badge variant="neutral">Off</Badge>}
                <ProblemBadge problem={routine.detail.disabledReason} />
              </>
            )}
            detail={routineWhen(routine, ": ")}
          />
        ))}
      </WorkSection>
      <LineEditor
        open={adding !== null}
        onOpenChange={(open) => { if (!open) setAdding(null); }}
        mode={{ kind: "create", preselected: { fixedWorkflowId: workflowId, ...(adding === "routine" ? { schedule: true } : {}) } }}
        // The panel lists this workflow's lines and routines; both refetch.
        onSaved={() => {
          void triggersQ.refetch();
          void subscriptionsQ.refetch();
        }}
      />
    </div>
  );
}
