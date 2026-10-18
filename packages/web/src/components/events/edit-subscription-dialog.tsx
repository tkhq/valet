import { type AssistantThreadPolicy, type Appearance, validateAppearance } from "@valet/shared";
import { PICK_A_THREAD_ERROR, RunsInField } from "~/components/presence/runs-in-field";
import { displayThreadPolicy, subjectKindForKeys } from "~/components/presence/thread-policy-copy";
import { AppearanceSettings } from "~/components/presence/appearance-settings";
import { Sentence } from "~/components/presence/sentence";
import {
  isCreatorScopeFilter,
  presenceSentenceParts,
  presenceWhenParts,
  runsInLabel,
  type SentenceNames,
  type ThreadTitles,
  type WorkflowNames,
} from "~/components/presence/sentences";
import { SentenceReview } from "./automation-review";
import { DeliveryPreferences, type DeliveryPreferencesValue } from "./delivery-preferences";
/**
 * EditSubscriptionDialog: edit an existing line of presence: name, events,
 * filters, and, for an assistant target, its prompt templates and its
 * thread policy (**Runs in**). The line's sentence, read from the current
 * draft, sits at the top. The creator scope the server adds to a mention
 * line is not a filter the reader edits, so it shows as a read-only line.
 * What the line does is shown read-only: the server pins the target's kind and
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
import { useRef, useState } from "react";
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
  toWireFilters,
  type UiFilterRow,
} from "./filter-editor";
import {
  PromptFields,
  promptFieldsFrom,
  type PromptFieldsValue,
} from "./prompt-fields";
import { buildSubscriptionPatch } from "./subscription-patch";

/**
 * The stored line's creator scope row, if it has one. It is read from the
 * stored line, not the draft, so it stays hidden while the reader changes
 * events.
 */
function creatorScopeRow(sub: EventSubscriptionWire, rows: readonly UiFilterRow[]): UiFilterRow | undefined {
  const team = sub.target.kind === "assistant" && sub.target.assistant === "team";
  if (team || !selectsSlackMention(sub.eventKeys)) return undefined;
  return rows.find((row) => toWireFilters([row]).some(isCreatorScopeFilter));
}

export function EditSubscriptionDialog({
  open,
  onOpenChange,
  sub,
  targetLabel,
  review = false,
  replacesNote,
  focus,
  names = {},
  threadTitles = {},
  workflows = [],
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
  /** The field that takes focus when the dialog opens. `appearance` opens
   * on Appears as, for a place page's overflow menu item of that name. */
  focus?: "appearance";
  /** The people the sentence may name: the viewer and the org members. */
  names?: SentenceNames;
  /** Known thread titles, for a pinned thread in the sentence. */
  threadTitles?: ThreadTitles;
  /** Workflow names, for a workflow line's sentence. */
  workflows?: WorkflowNames;
}) {
  const appearanceRef = useRef<HTMLDivElement>(null);
  const catalogQ = useEventCatalog();
  const patch = usePatchEventSubscription();
  const services = catalogQ.data?.services ?? [];

  const [deliveryPreferences, setDeliveryPreferences] = useState<DeliveryPreferencesValue>({
    deliveryPolicy: sub.target.kind === "assistant" ? sub.target.deliveryPolicy ?? "always" : "always",
    pauseOnOverlap: sub.target.kind === "assistant" ? sub.target.pauseOnOverlap ?? true : true,
  });
  const [appearance, setAppearance] = useState<Appearance>(sub.target.appearance ?? {});
  const [name, setName] = useState(sub.name);
  // Rows made once at mount (open time), so the creator scope row keeps its id.
  const [storedRows] = useState(() => fromWireFilters(sub.filters));
  const [creatorRowId] = useState(() => creatorScopeRow(sub, storedRows)?.id);
  const { keys, filterRows, setFilterRows, filterFields, toggleKey } = useSubscriptionMatch(
    services, sub.eventKeys, () => storedRows,
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
  // The creator scope stays on the line but out of the filter editor.
  const creatorRow = creatorRowId === undefined ? undefined : filterRows.find((row) => row.id === creatorRowId);
  const editableRows = creatorRow === undefined ? filterRows : filterRows.filter((row) => row.id !== creatorRow.id);
  const scopeWho = names.me !== undefined && names.me !== sub.createdBy
    ? `Only mentions by ${names.members?.[sub.createdBy] ?? "the person who set this up"}`
    : "Only your own mentions";
  // The draft as the line will read once saved.
  const draft: EventSubscriptionWire = {
    ...sub,
    name,
    eventKeys: [...keys],
    filters: toWireFilters(filterRows),
    target: sub.target.kind === "assistant"
      ? { ...sub.target, appearance, ...(thread !== null ? { thread } : {}) }
      : { ...sub.target, appearance },
  };
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
      setError("These events name no place to group threads by. Pick another Runs in option.");
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
        description={review ? (sub.enabled ? `${sub.name} is already on. Review its current configuration.` : "Review the saved proposal. It stays off until you turn it on.") : "Change what this matches. A save keeps what it does."}
        className="max-w-lg"
        onOpenAutoFocus={(event) => {
          if (focus !== "appearance") return;
          const input = appearanceRef.current?.querySelector("input");
          if (!input) return;
          event.preventDefault();
          input.focus();
          input.scrollIntoView?.({ block: "center" });
        }}
      >
        <div className="space-y-4">
          <p data-testid="edit-preview" aria-live="polite" className="rounded-md border border-line px-3 py-2 text-sm leading-relaxed text-ink">
            <Sentence parts={presenceSentenceParts(draft, catalogQ.data?.services, workflows, threadTitles, names)} links={false} />
          </p>
          <div className="grid gap-1">
            <Label htmlFor="edit-subscription-name">Name</Label>
            <Input
              id="edit-subscription-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name"
            />
          </div>

          <EventMatchStep
            services={services}
            catalogLoading={catalogQ.isLoading}
            catalogError={catalogQ.error != null}
            keys={keys}
            onToggleKey={toggleKey}
            filterFields={filterFields}
            filterRows={editableRows}
            onFilterChange={(rows) => setFilterRows(creatorRow === undefined ? rows : [creatorRow, ...rows])}
            anyChannel={anyChannel}
            onAnyChannelChange={setAnyChannel}
          />
          {creatorRow !== undefined && (
            <p data-testid="creator-scope" className="text-sm text-ink">
              {scopeWho}
              <span className="block text-xs text-muted">Valet added this when you made the line. It cannot be changed.</span>
            </p>
          )}

          <div className="rounded border border-line bg-ink-wash/40 px-3 py-2">
            <p className="text-xs font-medium text-muted">Do</p>
            <p className="mt-1 text-sm text-ink">{targetLabel}</p>
            <p className="mt-1 text-xs text-muted">
              You cannot change Do here. To change it, select Listen for… on the place,
              then delete this line.
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
              ruleKind="presence"
              workspace={threadWorkspace}
              eventKeys={[...keys]}
              disabled={patch.isPending}
            />
          )}

          {sub.ownerType === "user" && sub.target.kind === "assistant" && <DeliveryPreferences value={deliveryPreferences} onChange={setDeliveryPreferences} />}

          <div ref={appearanceRef}>
            <AppearanceSettings value={appearance} onChange={setAppearance} subscription disabled={patch.isPending} />
          </div>

          <SentenceReview
            facts={[
              { term: "When", value: <Sentence parts={presenceWhenParts(draft, catalogQ.data?.services, names)} links={false} /> },
              { term: "Do", value: targetLabel },
              ...(sub.target.kind === "assistant" && thread !== null
                ? [{ term: "Runs in", value: runsInLabel(thread, subjectKind, "presence", threadTitles[thread.mode === "existing" ? thread.threadId : ""]?.title ?? undefined) }]
                : []),
              { term: "Appears as", value: appearance.displayName?.trim() || "Valet" },
            ]}
            follow={sub.target.kind === "assistant" ? sub.target.follow : undefined}
            audience={sub.audience}
            workflowId={sub.target.kind === "workflow" ? sub.target.workflowId : undefined}
            replaces={review && !sub.enabled ? replacesNote : undefined}
          />
          {collisions !== null && (
            <CollisionNotice
              report={collisions.report}
              committed={collisions.committed}
              intent="save"
              replaces={sub.target.kind === "assistant" ? sub.target.replaces : undefined}
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
                {patch.isPending ? "Saving…" : review && !sub.enabled ? `Turn on ${sub.name}` : "Save"}
              </Button>
              {collisions !== null && collisions.report.blocking.length > 0 && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => save(true)}
                  disabled={patch.isPending}
                >
                  {review ? "Turn on anyway" : "Save anyway"}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
