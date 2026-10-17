import { type Presence, validatePresence } from "@valet/shared";
import { PresenceSettings } from "~/components/presence-settings";
import { AutomationReview } from "./automation-review";
import { DeliveryPreferences, type DeliveryPreferencesValue } from "./delivery-preferences";
import { useState } from "react";
import type {
  EventSubscriptionCollisionsWire,
  EventSubscriptionWire,
  EventSubscriptionThreadWire,
} from "@valet/api/wire";
import {
  Button,
  Input,
  Label,
} from "~/components/primitives";
import { useEventCatalog, usePatchEventSubscription } from "~/api/events";
import { errorText } from "~/lib/error-text";
import {
  selectsSlackMention,
  storedAnyChannel,
} from "~/lib/slack-mention";
import { CollisionNotice, collisionsFromError } from "./collision-notice";
import { EventMatchStep } from "./event-match-step";
import { useSubscriptionMatch, validateSubscriptionFilters } from "./subscription-match";
import {
  fromWireFilters,
} from "./filter-editor";
import {
  PromptFields,
  promptFieldsFrom,
  type PromptFieldsValue,
} from "./prompt-fields";
import { describeThreadDestination } from "./subscription-labels";
import { SubscriptionThreadDestination } from "./subscription-thread-destination";
import { buildSubscriptionPatch } from "./subscription-patch";

export function EditSubscriptionForm({
  onOpenChange,
  sub,
  targetLabel,
  review = false,
  replacesNote,
  readOnly = false,
}: {
  onOpenChange: (open: boolean) => void;
  sub: EventSubscriptionWire;
  /** The stored target as a display sentence (the row already resolves
   * workflow and team names); the form shows this label. */
  targetLabel: string;
  review?: boolean;
  readOnly?: boolean;
  /** The name of the subscription this proposal replaces, when it has one. */
  replacesNote?: string;
}) {
  // Compare against the opened revision. A refetch must not turn untouched
  // draft fields into changes that overwrite another editor. The page keys by ID.
  const [baseline] = useState(sub);
  const catalogQ = useEventCatalog();
  const patch = usePatchEventSubscription();
  const services = catalogQ.data?.services ?? [];

  const [deliveryPreferences, setDeliveryPreferences] = useState<DeliveryPreferencesValue>({
    deliveryPolicy: sub.target.kind === "orchestrator" ? sub.target.deliveryPolicy ?? "always" : "always",
    pauseOnOverlap: sub.target.kind === "orchestrator" ? sub.target.pauseOnOverlap ?? true : true,
  });
  const [thread, setThread] = useState<EventSubscriptionThreadWire | null>(sub.target.kind === "orchestrator" ? sub.target.thread ?? null : null);
  const [presence, setPresence] = useState<Presence>(sub.target.presence ?? {});
  const [name, setName] = useState(sub.name);
  const { keys, filterRows, setFilterRows, filterFields, toggleKey } = useSubscriptionMatch(
    services, sub.eventKeys, () => fromWireFilters(sub.filters),
  );
  const [anyChannel, setAnyChannel] = useState(() => storedAnyChannel(sub.eventKeys, sub.filters));
  // Seeded when this subscription opens. Only an assistant target has templates.
  const [prompts, setPrompts] = useState<PromptFieldsValue>(() =>
    promptFieldsFrom(sub.target.kind === "orchestrator" ? sub.target : {}),
  );
  const [error, setError] = useState<string | null>(null);
  // See the wizard: `committed: false` is a refused write (409) with a "Save
  // anyway" path; `committed: true` is a saved write that still overlaps.
  const [collisions, setCollisions] = useState<{
    report: EventSubscriptionCollisionsWire;
    committed: boolean;
  } | null>(null);

  function save(allowCollision = false) {
    if (readOnly) return;
    setError(null);
    if (thread?.mode === "existing" && (!thread.sessionId || !thread.threadId)) { setError("Select a destination thread."); return; }
    const presenceError = validatePresence(presence);
    if (presenceError) { setError(presenceError); return; }
    if (name.trim().length === 0) {
      setError("Enter a name.");
      return;
    }
    if (keys.size === 0) {
      setError("Select at least one event.");
      return;
    }
    const match = validateSubscriptionFilters(filterRows, {
      mention: selectsSlackMention([...keys]), anyChannel, requireChannelScope: true,
    });
    if (match.error !== undefined) {
      setError(match.error);
      return;
    }
    const { filters } = match;

    let body = buildSubscriptionPatch(baseline, {
      name,
      eventKeys: [...keys],
      filters,
      anyChannel,
      prompts,
      presence,
      thread,
      ...(sub.ownerType === "user" && sub.target.kind === "orchestrator" ? { deliveryPreferences } : {}),
    });
    if (review && !sub.enabled) body = { ...body, enabled: true };
    if (body === null) {
      onOpenChange(false);
      return;
    }
    if (allowCollision) body.allowCollision = true;

    patch.mutate(
      { id: sub.id, body },
      {
        onSuccess: (resp) => {
          if (resp.collisions !== undefined) {
            setCollisions({ report: resp.collisions, committed: true });
            return;
          }
          onOpenChange(false);
        },
        onError: (err) => {
          const report = collisionsFromError(err);
          if (report !== null) {
            setCollisions({ report, committed: false });
            return;
          }
          setCollisions(null);
          setError(errorText(err));
        },
      },
    );
  }

  return (
    <fieldset disabled={readOnly || patch.isPending} className="min-w-0 space-y-6">
        <div className="space-y-4">
          <div className="grid gap-1">
            <Label htmlFor="edit-subscription-name">Name</Label>
            <Input
              id="edit-subscription-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Automation name"
            />
          </div>

          <EventMatchStep
            services={services}
            catalogLoading={catalogQ.isLoading}
            catalogError={catalogQ.error != null}
            keys={keys}
            onToggleKey={toggleKey}
            filterFields={filterFields}
            filterRows={filterRows}
            onFilterChange={setFilterRows}
            singleEvent={false}
            anyChannel={anyChannel}
            onAnyChannelChange={setAnyChannel}
          />

          <div className="rounded border border-line bg-ink-wash/40 px-3 py-2">
            <p className="text-xs font-medium text-muted">Then</p>
            <p className="mt-1 text-sm text-ink">{targetLabel}</p>
            <p className="mt-1 text-xs text-muted">
              To change the workspace or workflow, create a new automation.
            </p>
            {sub.target.kind === "orchestrator" && sub.target.orchestrator !== "org" && !sub.target.follow && !readOnly && (
              <SubscriptionThreadDestination owner={{ ownerType: sub.ownerType, ownerId: sub.ownerId }} value={thread} onChange={setThread} disabled={patch.isPending} />
            )}
            {readOnly && sub.target.kind === "orchestrator" && <p className="mt-3 text-sm text-ink">
              Run in: {describeThreadDestination(sub.target.thread)}
            </p>}
            {/* The target stays fixed, but what the assistant reads is a field
                of this rule, so it is editable here. */}
            {sub.target.kind === "orchestrator" && (
              <PromptFields
                idPrefix="edit-subscription"
                value={prompts}
                onChange={setPrompts}
                followsThread={sub.target.follow === true}
              />
            )}
          </div>

          {sub.ownerType === "user" && sub.target.kind === "orchestrator" && <DeliveryPreferences value={deliveryPreferences} onChange={setDeliveryPreferences} />}

          <PresenceSettings value={presence} onChange={setPresence} subscription disabled={patch.isPending} />

          <AutomationReview follow={sub.target.kind === "orchestrator" ? sub.target.follow : undefined} audience={sub.audience} workflowId={sub.target.kind === "workflow" ? sub.target.workflowId : undefined} when={[...keys].join(", ")} scope={filterRows.map(row => `${row.field} ${row.op} ${row.label || row.value}`).join("; ") || "All matching events"}
            result={sub.target.kind === "orchestrator" ? prompts.userPromptTemplate || "Deliver matching events to the workspace assistant" : targetLabel}
            destination={sub.target.kind === "orchestrator" ? `${targetLabel} · ${describeThreadDestination(thread)}` : targetLabel} replaces={review && !sub.enabled ? replacesNote : undefined} />
          {collisions !== null && (
            <CollisionNotice
              report={collisions.report}
              committed={collisions.committed}
              intent="save"
            />
          )}
          {error && <p className="text-xs text-danger-500">{error}</p>}
        </div>

        {!readOnly && <div className="sticky bottom-0 flex flex-wrap justify-end gap-2 border-t border-line bg-paper py-4">
          {collisions?.committed === true ? (
            // The write landed; the notice above is the last word. No further
            // Save — resubmitting the same form would write again.
            <Button type="button" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="secondary"
                onClick={() => onOpenChange(false)}
                disabled={patch.isPending}
              >
                Cancel
              </Button>
              <Button type="button" onClick={() => save()} disabled={patch.isPending}>
                {patch.isPending ? "Saving…" : review && !sub.enabled ? "Enable subscription" : "Save"}
              </Button>
              {collisions !== null && collisions.report.blocking.length > 0 && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => save(true)}
                  disabled={patch.isPending}
                >
                  {review ? "Enable anyway" : "Save anyway"}
                </Button>
              )}
            </>
          )}
        </div>}
    </fieldset>
  );
}
