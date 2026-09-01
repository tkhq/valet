/**
 * TriggerDialog — create or edit a schedule or event trigger.
 *
 * Create: shows a kind picker (Schedule | Event). Edit: kind is locked to
 * `editing.kind` (immutable server-side).
 *
 * Schedule fields: name, cron, timezone (default: local), target radio
 * (workflow | orchestrator), workflow select (hidden when `workflowId` prop
 * set), prompt textarea (orchestrator target), input JSON textarea (workflow
 * target).
 *
 * Event fields: name, workflow select (same hide rule), event key select
 * (from useTriggerCatalog), filters JSON textarea.
 *
 * Edit sends only changed fields (partial update). Create sends all fields.
 * Server errors are rendered verbatim — server messages carry the corrective
 * action (e.g. "Use 5 fields, for example '0 9 * * 1-5'").
 */
import { useState, useEffect, useRef } from "react";
import type { WorkflowTriggerItem } from "@valet/api/wire";
import {
  useCreateEventTrigger,
  useCreateSchedule,
  useTriggerCatalog,
  useUpdateEventTrigger,
  useUpdateSchedule,
  useWorkflows,
} from "~/api/workflows";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  Label,
  Textarea,
} from "~/components/primitives";
import {
  FilterEditor,
  fromWireFilters,
  incompleteFilterRow,
  pruneFilterRows,
  toWireFilters,
  type UiFilterRow,
} from "~/components/events/filter-editor";
import {
  channelScopeFields,
  hasChannelScopeFilter,
  storedAnyChannel,
} from "~/lib/subscription-scope";

type TriggerKind = "schedule" | "event";
type TargetKind = "workflow" | "orchestrator";

function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function TriggerDialog({
  open,
  onOpenChange,
  workflowId,
  editing,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workflowId?: string;
  editing?: WorkflowTriggerItem;
}) {
  const isEditing = editing !== undefined;
  const lockedKind: TriggerKind | undefined = editing?.kind;

  // ── kind picker ────────────────────────────────────────────────────────
  const [kind, setKind] = useState<TriggerKind>(lockedKind ?? "schedule");

  // ── shared fields ──────────────────────────────────────────────────────
  const [name, setName] = useState("");

  // ── schedule fields ────────────────────────────────────────────────────
  const [cron, setCron] = useState("");
  const [timezone, setTimezone] = useState(defaultTimezone());
  const [targetKind, setTargetKind] = useState<TargetKind>("workflow");
  const [selectedWorkflowId, setSelectedWorkflowId] = useState(workflowId ?? "");
  const [prompt, setPrompt] = useState("");
  const [inputJson, setInputJson] = useState("");
  const [inputJsonError, setInputJsonError] = useState<string | null>(null);

  // ── event fields ───────────────────────────────────────────────────────
  const [eventKey, setEventKey] = useState("");
  const [filterRows, setFilterRows] = useState<UiFilterRow[]>([]);
  // Explicit opt-out of the channel requirement for scope-required events
  // (TKAI-302). Off by default; only rendered when the selected event
  // declares a channelField in its catalog scope.
  const [anyChannel, setAnyChannel] = useState(false);
  // Tracks whether the user has manually toggled the checkbox since the
  // dialog opened. A manual touch wins over the catalog-arrival re-seed
  // below (see "Mount-time state from props" in CLAUDE.md).
  const anyChannelTouched = useRef(false);

  // ── form error (client-side validation) ────────────────────────────────
  const [formError, setFormError] = useState<string | null>(null);

  // ── server error ───────────────────────────────────────────────────────
  const [serverError, setServerError] = useState<string | null>(null);

  const createSchedule = useCreateSchedule();
  const updateSchedule = useUpdateSchedule();
  const createEvent = useCreateEventTrigger();
  const updateEvent = useUpdateEventTrigger();
  const workflowsQ = useWorkflows();
  const catalogQ = useTriggerCatalog();

  // Flatten catalog entries to a single list for the event key select. Keep
  // each entry's filter fields so the Filters box can show which fields the
  // selected event actually declares.
  const catalogEntries = (catalogQ.data?.catalog ?? []).flatMap((svc) =>
    svc.entries.map((e) => ({
      key: e.key,
      label: `${e.key} — ${e.description}`,
      filters: e.filters,
      scope: e.scope,
    })),
  );
  const selectedEntry = catalogEntries.find((e) => e.key === eventKey);

  // Populate fields when editing.
  useEffect(() => {
    if (!open) return;
    anyChannelTouched.current = false;
    if (editing) {
      setKind(editing.kind);
      setName(editing.name);
      setFormError(null);
      setServerError(null);
      if (editing.kind === "schedule") {
        setCron(editing.detail.cron);
        setTimezone(editing.detail.timezone);
        setTargetKind(editing.detail.targetKind);
        setSelectedWorkflowId(editing.workflowId ?? workflowId ?? "");
        setPrompt(editing.detail.prompt ?? "");
        setInputJson(
          editing.detail.input != null ? JSON.stringify(editing.detail.input, null, 2) : "",
        );
      } else {
        setEventKey(editing.detail.eventKeys[0] ?? "");
        setFilterRows(fromWireFilters(editing.detail.filters));
        setAnyChannel(storedAnyChannel(catalogEntries, editing.detail.eventKeys, editing.detail.filters));
        setSelectedWorkflowId(editing.workflowId ?? workflowId ?? "");
      }
    } else {
      // Reset for create.
      setKind(lockedKind ?? "schedule");
      setName("");
      setCron("");
      setTimezone(defaultTimezone());
      setTargetKind("workflow");
      setSelectedWorkflowId(workflowId ?? "");
      setPrompt("");
      setInputJson("");
      setInputJsonError(null);
      setEventKey("");
      setFilterRows([]);
      setAnyChannel(false);
      setFormError(null);
      setServerError(null);
    }
  }, [open, editing, workflowId, lockedKind]); // catalogEntries intentionally omitted — see narrow re-seed below

  // Narrow re-seed: if the catalog arrives after the dialog opened while
  // editing an event trigger, re-seed anyChannel from storedAnyChannel. This
  // fixes the stale-closure bug where catalogEntries is [] at open time and
  // the main effect does not re-fire when data lands. Skipped if the user
  // has already touched the checkbox — their override wins.
  useEffect(() => {
    if (
      !open ||
      editing?.kind !== "event" ||
      anyChannelTouched.current
    ) return;
    setAnyChannel(storedAnyChannel(catalogEntries, editing.detail.eventKeys, editing.detail.filters));
  }, [open, editing, catalogQ.data]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Parse a JSON textarea. Empty input returns undefined (the caller picks
   * the default); a parse failure sets the field error and returns null. */
  function parseJson(
    raw: string,
    setError: (msg: string | null) => void,
    errorMessage = 'Input must be valid JSON, for example {"env": "prod"}',
  ): unknown {
    if (!raw.trim()) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      setError(null);
      return parsed;
    } catch {
      setError(errorMessage);
      return null;
    }
  }

  const workflows = workflowsQ.data?.workflows ?? [];
  const isPending =
    createSchedule.isPending ||
    updateSchedule.isPending ||
    createEvent.isPending ||
    updateEvent.isPending;

  async function submit() {
    setServerError(null);
    setFormError(null);
    setInputJsonError(null);

    // Client-side: require a workflow selection on create when the workflowId
    // prop is absent and a workflow target is needed.
    if (!isEditing) {
      const needsWorkflow =
        (kind === "schedule" && targetKind === "workflow") || kind === "event";
      if (needsWorkflow && !workflowId && !selectedWorkflowId) {
        setFormError("Select a workflow.");
        return;
      }
    }

    try {
      if (kind === "schedule") {
        // Parse input JSON if present.
        let parsedInput: unknown | undefined;
        if (inputJson.trim()) {
          const result = parseJson(inputJson, setInputJsonError);
          if (result === null) return;
          // Schedule input can be any JSON value; we pass it as-is.
          parsedInput = result;
        }

        if (isEditing) {
          // Send only changed fields.
          // editing.kind matches `kind` (set in the open-reset effect); TS can't narrow through useState
          const orig = editing as Extract<WorkflowTriggerItem, { kind: "schedule" }>;
          type ScheduleUpdate = {
            name?: string;
            cron?: string;
            timezone?: string;
            prompt?: string;
            input?: unknown;
          };
          const body: ScheduleUpdate = {};
          if (name !== orig.name) body.name = name;
          if (cron !== orig.detail.cron) body.cron = cron;
          if (timezone !== orig.detail.timezone) body.timezone = timezone;
          if (orig.detail.targetKind === "orchestrator" && prompt !== (orig.detail.prompt ?? "")) {
            body.prompt = prompt;
          }
          if (orig.detail.targetKind === "workflow") {
            if (parsedInput !== undefined) {
              body.input = parsedInput;
            } else if (!inputJson.trim() && orig.detail.input != null) {
              // Emptied the textarea on edit — clear the stored input.
              body.input = null;
            }
          }
          await updateSchedule.mutateAsync({ id: orig.id, body });
        } else {
          const base = { name, cron, timezone };
          if (targetKind === "orchestrator") {
            await createSchedule.mutateAsync({
              ...base,
              target: { kind: "orchestrator", prompt },
            });
          } else {
            const wfId = workflowId ?? selectedWorkflowId;
            const target: { kind: "workflow"; workflowId: string; input?: unknown } = {
              kind: "workflow",
              workflowId: wfId,
            };
            if (parsedInput !== undefined) target.input = parsedInput;
            await createSchedule.mutateAsync({ ...base, target });
          }
        }
      } else {
        // Event trigger.
        const incomplete = incompleteFilterRow(filterRows);
        if (incomplete) {
          setFormError(`Enter a value for the "${incomplete}" filter, or remove the row.`);
          return;
        }
        const filters = toWireFilters(filterRows);
        // Mirror the server's scope gate (TKAI-302) so the form names the gap
        // before a round trip.
        const scoped = selectedEntry !== undefined && selectedEntry.scope?.channelField !== undefined;
        if (scoped && !anyChannel && !hasChannelScopeFilter(filters, channelScopeFields([selectedEntry!], [eventKey]))) {
          setFormError(
            'This event needs a channel filter (equals, or is one of). Add one, or check "Any channel".',
          );
          return;
        }

        if (isEditing) {
          // editing.kind matches `kind` (set in the open-reset effect); TS can't narrow through useState
          const orig = editing as Extract<WorkflowTriggerItem, { kind: "event" }>;
          type EventUpdate = {
            name?: string;
            eventKeys?: string[];
            filters?: unknown[];
            anyChannel?: boolean;
          };
          const body: EventUpdate = {};
          if (name !== orig.name) body.name = name;
          if (eventKey !== (orig.detail.eventKeys[0] ?? "")) {
            body.eventKeys = [eventKey];
          }
          // Filters are what the rows say now. Send them only when they differ
          // from what was stored, including an empty set that clears them.
          if (JSON.stringify(filters) !== JSON.stringify(orig.detail.filters)) {
            body.filters = filters;
          }
          // A toggle of "Any channel" alone must still produce a write, or
          // the save is a silent no-op — send the (unchanged) filters so the
          // server re-runs the scope gate against the new flag.
          if (
            selectedEntry?.scope?.channelField !== undefined &&
            anyChannel !== storedAnyChannel(catalogEntries, orig.detail.eventKeys, orig.detail.filters) &&
            body.filters === undefined
          ) {
            body.filters = filters;
          }
          // The server re-checks channel scoping when the match changes, so
          // the opt-out must ride along then.
          if (
            (body.filters !== undefined || body.eventKeys !== undefined) &&
            selectedEntry?.scope?.channelField !== undefined &&
            anyChannel
          ) {
            body.anyChannel = true;
          }
          await updateEvent.mutateAsync({ id: orig.id, body });
        } else {
          const wfId = workflowId ?? selectedWorkflowId;
          await createEvent.mutateAsync({
            workflowId: wfId,
            name,
            eventKeys: [eventKey],
            filters,
            ...(selectedEntry?.scope?.channelField !== undefined && anyChannel ? { anyChannel: true } : {}),
          });
        }
      }

      onOpenChange(false);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Request failed.");
    }
  }

  const title = isEditing ? `Edit ${editing.name}` : "New trigger";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} className="max-w-2xl">
        <div className="grid gap-4">
          {/* Kind picker — only shown when creating */}
          {!isEditing && (
            <div className="flex gap-2">
              <Button
                variant={kind === "schedule" ? "primary" : "ghost"}
                size="sm"
                onClick={() => setKind("schedule")}
              >
                Schedule
              </Button>
              <Button
                variant={kind === "event" ? "primary" : "ghost"}
                size="sm"
                onClick={() => setKind("event")}
              >
                Event
              </Button>
            </div>
          )}

          {/* Name */}
          <div className="grid gap-1">
            <Label htmlFor="trigger-name">Name</Label>
            <Input
              id="trigger-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My trigger"
            />
          </div>

          {kind === "schedule" && (
            <>
              {/* Cron */}
              <div className="grid gap-1">
                <Label htmlFor="trigger-cron">Cron</Label>
                <Input
                  id="trigger-cron"
                  value={cron}
                  onChange={(e) => setCron(e.target.value)}
                  placeholder="0 9 * * 1-5"
                />
              </div>

              {/* Timezone */}
              <div className="grid gap-1">
                <Label htmlFor="trigger-timezone">Timezone</Label>
                <Input
                  id="trigger-timezone"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  placeholder="UTC"
                />
              </div>

              {/* Target radio — locked when editing */}
              {!isEditing && (
                <fieldset className="grid gap-1">
                  <legend className="text-sm font-medium text-ink">Target</legend>
                  <div className="flex gap-4 pt-1">
                    <label htmlFor="target-workflow" className="flex items-center gap-1.5 text-sm">
                      <input
                        id="target-workflow"
                        type="radio"
                        name="trigger-target"
                        value="workflow"
                        checked={targetKind === "workflow"}
                        onChange={() => setTargetKind("workflow")}
                        aria-label="workflow"
                      />
                      Workflow
                    </label>
                    <label
                      htmlFor="target-orchestrator"
                      className="flex items-center gap-1.5 text-sm"
                    >
                      <input
                        id="target-orchestrator"
                        type="radio"
                        name="trigger-target"
                        value="orchestrator"
                        checked={targetKind === "orchestrator"}
                        onChange={() => setTargetKind("orchestrator")}
                        aria-label="orchestrator"
                      />
                      Orchestrator
                    </label>
                  </div>
                </fieldset>
              )}

              {/* Workflow select — hidden when workflowId prop is set */}
              {!workflowId && targetKind === "workflow" && (
                <div className="grid gap-1">
                  <Label htmlFor="trigger-workflow">Workflow</Label>
                  <select
                    id="trigger-workflow"
                    value={selectedWorkflowId}
                    onChange={(e) => setSelectedWorkflowId(e.target.value)}
                    disabled={isEditing}
                    className="w-full min-w-0 truncate rounded border border-line bg-paper px-2 py-1.5 text-sm text-ink"
                  >
                    <option value="">— select workflow —</option>
                    {workflows.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Prompt textarea — orchestrator target */}
              {(targetKind === "orchestrator" ||
                (isEditing &&
                  // editing.kind matches `kind` (set in the open-reset effect); TS can't narrow through useState
                  (editing as Extract<WorkflowTriggerItem, { kind: "schedule" }>).detail
                    .targetKind === "orchestrator")) && (
                <div className="grid gap-1">
                  <Label htmlFor="trigger-prompt">Prompt</Label>
                  <Textarea
                    id="trigger-prompt"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={4}
                    placeholder="Summarize overnight changes"
                  />
                </div>
              )}

              {/* Input JSON textarea — workflow target */}
              {(targetKind === "workflow" ||
                (isEditing &&
                  // editing.kind matches `kind` (set in the open-reset effect); TS can't narrow through useState
                  (editing as Extract<WorkflowTriggerItem, { kind: "schedule" }>).detail
                    .targetKind === "workflow")) && (
                <div className="grid gap-1">
                  <Label htmlFor="trigger-input">Input (JSON)</Label>
                  <Textarea
                    id="trigger-input"
                    value={inputJson}
                    onChange={(e) => setInputJson(e.target.value)}
                    rows={8}
                    placeholder='{"env": "prod"}'
                    className="font-mono"
                  />
                  {inputJsonError && (
                    <div className="text-xs text-danger-500">{inputJsonError}</div>
                  )}
                </div>
              )}
            </>
          )}

          {kind === "event" && (
            <>
              {/* Workflow select — hidden when workflowId prop is set */}
              {!workflowId && (
                <div className="grid gap-1">
                  <Label htmlFor="trigger-event-workflow">Workflow</Label>
                  <select
                    id="trigger-event-workflow"
                    value={selectedWorkflowId}
                    onChange={(e) => setSelectedWorkflowId(e.target.value)}
                    disabled={isEditing}
                    className="w-full min-w-0 truncate rounded border border-line bg-paper px-2 py-1.5 text-sm text-ink"
                  >
                    <option value="">— select workflow —</option>
                    {workflows.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                  {workflows.length === 0 && (
                    <p className="text-xs text-muted">
                      You have no workflows yet — create one on the Workflows page to use as a target.
                    </p>
                  )}
                </div>
              )}

              {/* Event key select — from useTriggerCatalog() */}
              <div className="grid gap-1">
                <Label htmlFor="trigger-event-key">Event</Label>
                <select
                  id="trigger-event-key"
                  value={eventKey}
                  onChange={(e) => {
                    const key = e.target.value;
                    setEventKey(key);
                    // Drop filters that the newly-selected event does not
                    // declare, so a leftover filter cannot 400 on submit.
                    const entry = catalogEntries.find((c) => c.key === key);
                    setFilterRows((rows) => pruneFilterRows(rows, entry?.filters ?? []));
                  }}
                  className="w-full min-w-0 truncate rounded border border-line bg-paper px-2 py-1.5 text-sm text-ink"
                >
                  <option value="">— select event —</option>
                  {catalogEntries.map((entry) => (
                    <option key={entry.key} value={entry.key}>
                      {entry.label}
                    </option>
                  ))}
                </select>
                {catalogQ.isLoading && <p className="text-xs text-muted">Loading events…</p>}
                {catalogQ.error != null && (
                  <p className="text-xs text-danger-500">Failed to load the event catalog.</p>
                )}
              </div>

              {/* Filters — field/op/value rows from the event catalog */}
              <div className="grid gap-1.5">
                <Label>Filters</Label>
                {selectedEntry ? (
                  <>
                    <FilterEditor fields={selectedEntry.filters} rows={filterRows} onChange={setFilterRows} />
                    <p className="text-xs text-muted">
                      A trigger fires only when every filter matches. Add none to match every event of this type.
                    </p>
                    {/* Channel scope (TKAI-302): the server requires a channel
                        filter on this event unless the explicit opt-out is
                        set. Copy splits on whether the entry also pins the
                        rule to the creator's identity. */}
                    {selectedEntry.scope?.channelField !== undefined && (
                      <label className="flex items-start gap-2 text-sm text-ink">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={anyChannel}
                          onChange={(e) => {
                            anyChannelTouched.current = true;
                            setAnyChannel(e.target.checked);
                          }}
                        />
                        <span>
                          Any channel
                          <span className="block text-xs text-muted">
                            {selectedEntry.scope?.creatorUserField !== undefined
                              ? "A mention trigger fires only for your own @-mentions and needs a channel filter. Check this to listen in every channel the app can see instead."
                              : "This event needs a channel filter. Check this to listen in every channel the app can see instead."}
                          </span>
                          {anyChannel &&
                            selectedEntry.scope?.creatorUserField === undefined &&
                            selectedEntry.filters.some((f) => f.field === "text") && (
                              <span className="block text-xs text-muted">
                                Tip: add a text filter (for example a command prefix) so the rule fires only on
                                messages addressed to it.
                              </span>
                            )}
                        </span>
                      </label>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-muted">Select an event to add filters.</p>
                )}
              </div>
            </>
          )}

          {/* Form validation error */}
          {formError && (
            <div className="rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-xs text-danger-600">
              {formError}
            </div>
          )}

          {/* Server error */}
          {serverError && (
            <div className="rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-xs text-danger-600">
              {serverError}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={isPending}>
            {isPending ? (isEditing ? "Saving…" : "Creating…") : isEditing ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
