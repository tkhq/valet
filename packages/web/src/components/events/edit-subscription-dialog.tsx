import { type AssistantThreadPolicy, type Appearance, validateAppearance } from "@valet/shared";
import { PICK_A_THREAD_ERROR, RunsInField } from "~/components/presence/runs-in-field";
import { displayThreadPolicy, subjectKindForKeys } from "~/components/presence/thread-policy-copy";
import { AppearanceSettings } from "~/components/presence/appearance-settings";
import { AutomationReview } from "./automation-review";
import { DeliveryPreferences, type DeliveryPreferencesValue } from "./delivery-preferences";
/**
 * EditSubscriptionDialog — edit an existing event subscription: name, event
 * keys, filters, and, for an assistant target, its prompt templates and its
 * thread policy (**Runs in**). The
 * target itself is shown read-only: the server pins the target's kind and
 * owner on PATCH (only a same-owner `assistantId` re-point is accepted, which
 * this dialog does not offer yet), so pointing a rule at a different target is
 * a delete-and-recreate, not an edit.
 *
 * A save sends only the changed fields (`buildSubscriptionPatch`), with the
 * wizard's collision handling: a 409 shows the colliding rules and offers
 * "Save anyway"; a committed write that still overlaps shows the warning,
 * then Done.
 *
 * Mount only while open: the form seeds from `sub` at mount, so mount time
 * must be open time (the same rule the wizard's header comment states).
 */
import { useState } from "react";
import type {
  EventSubscriptionCollisionsWire,
  EventSubscriptionWire,
} from "@valet/api/wire";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
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
import { buildSubscriptionPatch } from "./subscription-patch";

export function EditSubscriptionDialog({
  open,
  onOpenChange,
  sub,
  targetLabel,
  review = false,
  replacesNote,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sub: EventSubscriptionWire;
  /** The stored target as a display sentence (the row already resolves
   * workflow and team names); the dialog only shows it. */
  targetLabel: string;
  review?: boolean;
  /** The name of the subscription this proposal replaces, when it has one. */
  replacesNote?: string;
}) {
  const catalogQ = useEventCatalog();
  const patch = usePatchEventSubscription();
  const services = catalogQ.data?.services ?? [];

  const [deliveryPreferences, setDeliveryPreferences] = useState<DeliveryPreferencesValue>({
    deliveryPolicy: sub.target.kind === "assistant" ? sub.target.deliveryPolicy ?? "always" : "always",
    pauseOnOverlap: sub.target.kind === "assistant" ? sub.target.pauseOnOverlap ?? true : true,
  });
  const [appearance, setAppearance] = useState<Appearance>(sub.target.appearance ?? {});
  const [name, setName] = useState(sub.name);
  const { keys, filterRows, setFilterRows, filterFields, toggleKey } = useSubscriptionMatch(
    services, sub.eventKeys, () => fromWireFilters(sub.filters),
  );
  const [anyChannel, setAnyChannel] = useState(() => storedAnyChannel(sub.eventKeys, sub.filters));
  // Seeded from the stored target at mount, which is open time (see the
  // header comment). Only an assistant target renders a template.
  const [prompts, setPrompts] = useState<PromptFieldsValue>(() =>
    promptFieldsFrom(sub.target.kind === "assistant" ? sub.target : {}),
  );
  // Seeded at mount (open time) with the policy the row runs with today, so
  // a rule with no stored policy shows its effective default. Null while
  // "An existing thread…" is chosen and no thread is picked yet.
  const [thread, setThread] = useState<AssistantThreadPolicy | null>(() =>
    sub.target.kind === "assistant" ? displayThreadPolicy(sub.target, sub.eventKeys) : { mode: "own" },
  );
  const subjectKind = subjectKindForKeys([...keys]);
  // The picker lists the rule owner's assistant threads. The org assistant
  // has no workspace key, so an org rule cannot pin a thread here.
  const threadWorkspace = sub.ownerType === "user" ? "user" : sub.ownerType === "team" ? sub.ownerId : undefined;
  const [error, setError] = useState<string | null>(null);
  // See the wizard: `committed: false` is a refused write (409) with a "Save
  // anyway" path; `committed: true` is a saved write that still overlaps.
  const [collisions, setCollisions] = useState<{
    report: EventSubscriptionCollisionsWire;
    committed: boolean;
  } | null>(null);

  function save(allowCollision = false) {
    setError(null);
    const appearanceError = validateAppearance(appearance);
    if (appearanceError) { setError(appearanceError); return; }
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
    const assistant = sub.target.kind === "assistant";
    if (assistant && thread === null) {
      setError(PICK_A_THREAD_ERROR);
      return;
    }
    if (assistant && thread?.mode === "subject" && subjectKind === null) {
      setError("This rule's events have no subject to group by. Pick another thread option.");
      return;
    }

    let body = buildSubscriptionPatch(sub, {
      name,
      eventKeys: [...keys],
      filters,
      anyChannel,
      prompts,
      appearance,
      ...(assistant && thread !== null ? { thread } : {}),
      ...(sub.ownerType === "user" && sub.target.kind === "assistant" ? { deliveryPreferences } : {}),
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={`${review ? "Review" : "Edit"} ${sub.name}`}
        description={review ? (sub.enabled ? "This subscription is already enabled. Review its current configuration." : "Review the saved proposal. It stays paused until you enable it.") : "Change what this automation matches. A save keeps its target."}
        className="max-w-lg"
      >
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
              This dialog cannot change the target. To use a different target, create a new
              automation and delete this one.
            </p>
            {/* The target stays fixed, but what the assistant reads is a field
                of this rule, so it is editable here. */}
            {sub.target.kind === "assistant" && (
              <PromptFields
                idPrefix="edit-subscription"
                value={prompts}
                onChange={setPrompts}
                followsThread={sub.target.follow === true}
              />
            )}
          </div>

          {sub.target.kind === "assistant" && (
            <RunsInField
              idPrefix="edit-subscription"
              value={thread}
              onChange={setThread}
              subjectKind={subjectKind}
              ruleKind="listener"
              workspace={threadWorkspace}
              eventKeys={[...keys]}
              disabled={patch.isPending}
            />
          )}

          {sub.ownerType === "user" && sub.target.kind === "assistant" && <DeliveryPreferences value={deliveryPreferences} onChange={setDeliveryPreferences} />}

          <AppearanceSettings value={appearance} onChange={setAppearance} subscription disabled={patch.isPending} />

          <AutomationReview follow={sub.target.kind === "assistant" ? sub.target.follow : undefined} audience={sub.audience} workflowId={sub.target.kind === "workflow" ? sub.target.workflowId : undefined} when={[...keys].join(", ")} scope={filterRows.map(row => `${row.field} ${row.op} ${row.label || row.value}`).join("; ") || "All matching events"}
            result={sub.target.kind === "assistant" ? prompts.userPromptTemplate || "Deliver matching events to the workspace assistant" : targetLabel}
            destination={targetLabel} replaces={review && !sub.enabled ? replacesNote : undefined} />
          {collisions !== null && (
            <CollisionNotice
              report={collisions.report}
              committed={collisions.committed}
              intent="save"
            />
          )}
          {error && <p className="text-xs text-danger-500">{error}</p>}
        </div>

        <DialogFooter>
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
