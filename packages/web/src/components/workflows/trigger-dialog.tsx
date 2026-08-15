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
import { useState, useEffect } from "react";
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
} from "~/components/primitives";

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
  const [filtersJson, setFiltersJson] = useState("");
  const [filtersJsonError, setFiltersJsonError] = useState<string | null>(null);

  // ── server error ───────────────────────────────────────────────────────
  const [serverError, setServerError] = useState<string | null>(null);

  const createSchedule = useCreateSchedule();
  const updateSchedule = useUpdateSchedule();
  const createEvent = useCreateEventTrigger();
  const updateEvent = useUpdateEventTrigger();
  const workflowsQ = useWorkflows();
  const catalogQ = useTriggerCatalog();

  // Flatten catalog entries to a single list for the event key select.
  const catalogEntries = (catalogQ.data?.catalog ?? []).flatMap((svc) =>
    svc.entries.map((e) => ({ key: e.key, label: `${e.key} — ${e.description}` })),
  );

  // Populate fields when editing.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setKind(editing.kind);
      setName(editing.name);
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
        setFiltersJson(
          editing.detail.filters.length > 0
            ? JSON.stringify(editing.detail.filters, null, 2)
            : "",
        );
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
      setFiltersJson("");
      setFiltersJsonError(null);
      setServerError(null);
    }
  }, [open, editing, workflowId, lockedKind]);

  function parseJson(raw: string, setError: (msg: string | null) => void): unknown {
    if (!raw.trim()) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      setError(null);
      return parsed;
    } catch {
      setError('Input must be valid JSON, for example {"env": "prod"}');
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
    setInputJsonError(null);
    setFiltersJsonError(null);

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
          if (orig.detail.targetKind === "workflow" && parsedInput !== undefined) {
            body.input = parsedInput;
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
        const filtersResult = parseJson(filtersJson, setFiltersJsonError);
        if (filtersResult === null) return;
        if (!Array.isArray(filtersResult)) {
          setFiltersJsonError("Filters must be a JSON array, for example []");
          return;
        }
        const filters = filtersResult;

        if (isEditing) {
          // editing.kind matches `kind` (set in the open-reset effect); TS can't narrow through useState
          const orig = editing as Extract<WorkflowTriggerItem, { kind: "event" }>;
          type EventUpdate = {
            name?: string;
            eventKeys?: string[];
            filters?: unknown[];
          };
          const body: EventUpdate = {};
          if (name !== orig.name) body.name = name;
          if (eventKey !== (orig.detail.eventKeys[0] ?? "")) {
            body.eventKeys = [eventKey];
          }
          if (filtersJson.trim()) body.filters = filters;
          await updateEvent.mutateAsync({ id: orig.id, body });
        } else {
          const wfId = workflowId ?? selectedWorkflowId;
          await createEvent.mutateAsync({
            workflowId: wfId,
            name,
            eventKeys: [eventKey],
            filters,
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
      <DialogContent title={title}>
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
                    className="rounded border border-line bg-paper px-2 py-1.5 text-sm text-ink"
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
                  <textarea
                    id="trigger-prompt"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={3}
                    placeholder="Summarize overnight changes"
                    className="rounded border border-line bg-paper px-2 py-1.5 text-sm text-ink resize-none"
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
                  <textarea
                    id="trigger-input"
                    value={inputJson}
                    onChange={(e) => setInputJson(e.target.value)}
                    rows={3}
                    placeholder='{"env": "prod"}'
                    className="rounded border border-line bg-paper px-2 py-1.5 text-sm font-mono text-ink resize-none"
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
                    className="rounded border border-line bg-paper px-2 py-1.5 text-sm text-ink"
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

              {/* Event key select — from useTriggerCatalog() */}
              <div className="grid gap-1">
                <Label htmlFor="trigger-event-key">Event</Label>
                <select
                  id="trigger-event-key"
                  value={eventKey}
                  onChange={(e) => setEventKey(e.target.value)}
                  className="rounded border border-line bg-paper px-2 py-1.5 text-sm text-ink"
                >
                  <option value="">— select event —</option>
                  {catalogEntries.map((entry) => (
                    <option key={entry.key} value={entry.key}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Filters as raw JSON textarea */}
              <div className="grid gap-1">
                <Label htmlFor="trigger-filters">Filters (JSON)</Label>
                <textarea
                  id="trigger-filters"
                  value={filtersJson}
                  onChange={(e) => setFiltersJson(e.target.value)}
                  rows={3}
                  placeholder='[{"field": "branch", "value": "main"}]'
                  className="rounded border border-line bg-paper px-2 py-1.5 text-sm font-mono text-ink resize-none"
                />
                {filtersJsonError && (
                  <div className="text-xs text-danger-500">{filtersJsonError}</div>
                )}
              </div>
            </>
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
