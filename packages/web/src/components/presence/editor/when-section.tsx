/**
 * The editor's **When** section (docs/specs/2026-10-16-presence-hub-design.md
 * Part H steps 3 and 7): the service choices, the events in words, the
 * conditions as pills, and for `On a schedule` the day and time control.
 * For Slack, `A reply in one Slack thread` takes a pasted message link in
 * place of the events.
 */
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ErrorRow, Button, Input, LoadingRow } from "~/components/primitives";
import { FilterValuePicker, fieldLabel, toWireFilters, type FilterField, type FilterOp, type UiFilterRow } from "~/components/events/filter-editor";
import { splitCommon } from "~/components/events/event-match-step";
import { ScheduleMatchStep } from "~/components/events/schedule-step";
import { EVENT_SERVICES } from "~/components/events/when-do-step";
import { unionFilterFields, type CatalogService } from "~/components/events/subscription-match";
import type { WhenService } from "~/components/events/wizard-preview";
import { selectsSlackMention, hasChannelScopeFilter } from "~/lib/slack-mention";
import { cn } from "~/lib/cn";
import { formatDateTime } from "~/lib/format-when";
import { ServiceGlyph, ServiceMark, SERVICE_NAMES, glyphColor } from "../service-mark";
import { eventLabel, SENTENCE_PLACE_FIELD_SET, type SentenceNames } from "../sentences";
import { BAD_THREAD_LINK, parseSlackThreadLink } from "./slack-thread-link";
import {
  addCondition,
  draftThread,
  hasCreatorScope,
  removeCondition,
  scheduleCron,
  setService,
  setThreadFollow,
  setThreadLink,
  toggleEvent,
  type Draft,
  type EditorMode,
  type EditorService,
} from "./draft";

const SERVICE_CHOICES: readonly EditorService[] = [...EVENT_SERVICES, "schedule"];

/** Mirrors the private `opWords` in sentences.ts, which this change may not
 * touch; fold the two together when that file opens again. */
const OP_WORDS: Readonly<Record<FilterOp, string>> = {
  eq: "is",
  in: "is",
  prefix: "starts with",
  contains: "contains",
  regex: "matches",
};

/** A condition in words: `repository is acme/api`, `channel is #a or #b`. */
export function conditionWords(row: UiFilterRow): string {
  const field = fieldLabel(row.field).toLowerCase();
  let value: string;
  if (row.op === "in") {
    const values = row.value.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
    const labels = row.inLabels !== undefined && row.inLabels.values.join(",") === values.join(",") ? row.inLabels.labels : values;
    value = labels.join(" or ");
  } else {
    value = row.label?.trim() || row.value;
  }
  return `${field} ${OP_WORDS[row.op]} ${value}`;
}

/** Who a mention line hears, for the creator scope pill. */
function creatorWords(mode: EditorMode, names: SentenceNames): string {
  if (mode.kind !== "edit" && mode.kind !== "review") return "your own mentions";
  const creator = mode.line.createdBy;
  if (names.me === undefined || names.me === creator) return "your own mentions";
  return `mentions by ${names.members?.[creator] ?? "the person who set this up"}`;
}

export function WhenSection({
  draft,
  mode,
  onChange,
  services,
  catalogLoading,
  catalogError,
  connected,
  names = {},
  onServicePicked,
}: {
  draft: Draft;
  mode: EditorMode;
  onChange: (next: Draft) => void;
  /** Every service the event catalog lists. */
  services: readonly CatalogService[];
  catalogLoading: boolean;
  catalogError: boolean;
  /** The connected services, or null while unknown. */
  connected: ReadonlySet<WhenService> | null;
  names?: SentenceNames;
  /** Called when the reader picks a service, so a later default does not move it. */
  onServicePicked?: () => void;
}) {
  // A stored line keeps its service and a stored routine stays a routine:
  // the two live in different stores, and a line's Do depends on its service.
  // Launched from a place, the service is the place's (Part H step 3).
  const placeService = mode.kind === "create" ? mode.preselected?.place?.service : undefined;
  const fixed = mode.kind !== "create" || placeService !== undefined;
  const choices = fixed ? SERVICE_CHOICES.filter((s) => s === draft.service) : SERVICE_CHOICES;
  return (
    <>
      <div role="group" aria-labelledby="editor-when-service" className="min-w-0">
        <p id="editor-when-service" className="mb-1.5 text-xs text-muted">Service</p>
        <div className="flex flex-wrap gap-2">
          {choices.map((service) => {
            // A fixed service stays open: the place or the line exists, so its events arrive.
            const off = !fixed && service !== "schedule" && connected !== null && !connected.has(service);
            const on = draft.service === service;
            return (
              <button
                key={service}
                type="button"
                aria-pressed={on}
                disabled={off || fixed}
                onClick={() => {
                  onServicePicked?.();
                  onChange(setService(draft, service));
                }}
                className={cn(
                  "inline-flex min-h-11 items-center gap-2 rounded-lg border border-line py-1.5 pl-1.5 pr-3 text-sm sm:min-h-0",
                  on ? "border-ink ring-1 ring-ink" : "hover:bg-ink-wash",
                  off ? "cursor-not-allowed text-muted opacity-70" : "text-ink",
                )}
              >
                <ServiceMark service={service} size="md" className={off ? "opacity-60" : undefined} />
                {SERVICE_NAMES[service]}
                {off && <span className="text-xs text-muted">Connect first</span>}
              </button>
            );
          })}
        </div>
        {!fixed && connected !== null && SERVICE_CHOICES.some((s) => s !== "schedule" && !connected.has(s)) && (
          <p className="mt-1.5 text-xs text-muted">
            To use another service, connect it in{" "}
            <Link to="/integrations" className="text-ink underline">Integrations</Link>.
          </p>
        )}
      </div>
      {draft.service === "schedule" ? (
        <ScheduleMatchStep
          days={draft.schedule.days}
          onDaysChange={(days) => onChange({ ...draft, schedule: { ...draft.schedule, days } })}
          time={draft.schedule.time}
          onTimeChange={(time) => onChange({ ...draft, schedule: { ...draft.schedule, time } })}
          cron={scheduleCron(draft.schedule)}
          cronOverride={draft.schedule.cronOverride}
          onCronChange={(value) => onChange({ ...draft, schedule: { ...draft.schedule, cronOverride: value.trim().length > 0 ? value : null } })}
          timezone={draft.schedule.timezone}
          onTimezoneChange={(timezone) => onChange({ ...draft, schedule: { ...draft.schedule, timezone } })}
        />
      ) : (
        <>
          {draft.service === "slack" && (mode.kind === "create" || draft.threadFollow) && (
            <SlackListenFor draft={draft} onChange={onChange} locked={mode.kind !== "create"} />
          )}
          {draft.threadFollow ? (
            <ThreadLink draft={draft} onChange={onChange} />
          ) : (
            <Events
              draft={draft}
              create={mode.kind === "create"}
              onChange={onChange}
              services={services}
              loading={catalogLoading}
              error={catalogError}
            />
          )}
          <Conditions draft={draft} mode={mode} onChange={onChange} services={services} names={names} />
        </>
      )}
    </>
  );
}

/** Slack's two modes: events (a mention among them), or the replies in one thread. */
function SlackListenFor({ draft, onChange, locked }: { draft: Draft; onChange: (next: Draft) => void; locked: boolean }) {
  const options = [
    { follow: false, title: "A mention or other events" },
    { follow: true, title: "A reply in one Slack thread" },
  ] as const;
  return (
    <div role="radiogroup" aria-label="Listen for" className="grid gap-1.5">
      {options.map((option) => (
        <label key={option.title} className="flex min-h-11 items-center gap-2.5 text-[15px] text-ink sm:min-h-0">
          <input
            type="radio"
            name="editor-slack-listen-for"
            checked={draft.threadFollow === option.follow}
            disabled={locked}
            onChange={() => onChange(setThreadFollow(draft, option.follow))}
          />
          {option.title}
        </label>
      ))}
    </div>
  );
}

/**
 * The hint under the link field of a stored thread follow, in words: the
 * time the thread started and its channel's name. A channel with no name
 * stays out, so no raw Slack id shows. `timeZone` is for tests.
 */
export function threadFollowHint(
  thread: { channel: string; channelLabel: string; threadTs: string },
  options: { timeZone?: string } = {},
): string {
  const seconds = Number(thread.threadTs);
  const started = Number.isFinite(seconds) && seconds > 0 ? ` started ${formatDateTime(seconds * 1000, options)}` : "";
  const named = thread.channelLabel.length > 0 && thread.channelLabel !== thread.channel ? ` in ${thread.channelLabel}` : "";
  return `Follows the thread${started}${named}. Paste another link to follow a different thread.`;
}

/** The thread's link. A link that parses sets the channel and thread conditions. */
function ThreadLink({ draft, onChange }: { draft: Draft; onChange: (next: Draft) => void }) {
  const bad = draft.threadLink.trim().length > 0 && parseSlackThreadLink(draft.threadLink) === null;
  const thread = draftThread(draft);
  return (
    <div className="grid gap-1">
      <label htmlFor="editor-thread-link" className="text-xs text-muted">Paste the thread's link</label>
      <Input
        id="editor-thread-link"
        value={draft.threadLink}
        onChange={(e) => onChange(setThreadLink(draft, e.target.value))}
        placeholder="https://your-team.slack.com/archives/…"
        aria-invalid={bad}
        className="min-w-0"
      />
      {bad
        ? <p role="alert" className="text-xs text-danger-500">{BAD_THREAD_LINK}</p>
        : thread !== null && draft.threadLink.trim().length === 0
          ? <p className="text-xs text-muted">{threadFollowHint(thread)}</p>
          : <p className="text-xs text-muted">In Slack, copy the link from a message's menu. Only later human replies in that thread match. Valet must have access to the channel.</p>}
    </div>
  );
}

function Events({ draft, create, onChange, services, loading, error }: {
  draft: Draft;
  /** True on a new line: unchecking the last mention then turns Reply into Work on it. */
  create: boolean;
  onChange: (next: Draft) => void;
  services: readonly CatalogService[];
  loading: boolean;
  error: boolean;
}) {
  const service = services.find((s) => s.service === draft.service);
  const { common, more } = service !== undefined ? splitCommon(service) : { common: [], more: [] };
  const [moreOpen, setMoreOpen] = useState(() => more.some((e) => draft.events.has(e.key)));
  const option = (entry: { key: string }) => (
    <label key={entry.key} className="flex min-h-11 items-center gap-2.5 text-[15px] text-ink sm:min-h-0">
      <input
        type="checkbox"
        checked={draft.events.has(entry.key)}
        onChange={() => onChange(toggleEvent(draft, entry.key, services, { create }))}
      />
      {eventLabel(entry.key, [...services])}
    </label>
  );
  return (
    <div role="group" aria-labelledby="editor-when-events" className="min-w-0">
      <p id="editor-when-events" className="mb-1.5 text-xs text-muted">Events</p>
      {loading && <LoadingRow label="Loading events…" className="py-2 text-xs" />}
      {error && <ErrorRow className="py-2 text-xs">Could not load the events. Reload the page, or check your integrations.</ErrorRow>}
      {!loading && !error && service === undefined && (
        <p className="text-xs text-muted">This service sends no events yet. Connect it in Integrations first.</p>
      )}
      <div className="grid gap-1.5">
        {common.map(option)}
        {more.length > 0 && (
          <details open={moreOpen} onToggle={(e) => setMoreOpen(e.currentTarget.open)}>
            <summary className="cursor-pointer py-1 text-xs text-muted hover:text-ink">More events ({more.length})</summary>
            <div className="mt-1 grid gap-1.5">{more.map(option)}</div>
          </details>
        )}
      </div>
      {draft.events.size > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted hover:text-ink">Advanced</summary>
          <ul className="mt-1 space-y-0.5">
            {[...draft.events].map((key) => (
              <li key={key} className="break-all font-mono text-[11px] text-muted">{key}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** What a condition can test, in the words of the service's own fields. */
export function conditionHint(service: WhenService | undefined): string {
  const examples = service === "github" ? "a branch or an author" : service === "linear" ? "a team or a label" : "a channel or a sender";
  return `Any field these events carry, such as ${examples}.`;
}

function Conditions({ draft, mode, onChange, services, names }: {
  draft: Draft;
  mode: EditorMode;
  onChange: (next: Draft) => void;
  services: readonly CatalogService[];
  names: SentenceNames;
}) {
  const [adding, setAdding] = useState(false);
  const fields = unionFilterFields([...services], draft.events);
  const mention = selectsSlackMention([...draft.events]);
  const scoped = hasChannelScopeFilter(toWireFilters([...draft.conditions]));
  const creator = hasCreatorScope(draft);
  const service = draft.service === "schedule" ? undefined : draft.service;
  const rows = draft.conditions.filter((row) => row.id !== draft.creatorScopeId);
  return (
    <div role="group" aria-labelledby="editor-when-only" className="min-w-0">
      <p id="editor-when-only" className="mb-1.5 text-xs text-muted">Only when</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {rows.map((row) => {
          const words = conditionWords(row);
          const place = service !== undefined && SENTENCE_PLACE_FIELD_SET.has(row.field);
          return (
            <span key={row.id} className="inline-flex items-center gap-1.5 rounded-full bg-ink-wash py-0.5 pl-2 pr-1 text-[13px] text-ink">
              {place && (
                <span aria-hidden="true" style={{ color: glyphColor(service) }} className="inline-grid">
                  <ServiceGlyph service={service} size={12} />
                </span>
              )}
              {words}
              <button
                type="button"
                aria-label={`Remove ${words}`}
                onClick={() => onChange(removeCondition(draft, row.id))}
                className="inline-grid h-5 w-5 place-items-center rounded-full text-muted hover:bg-ink-wash hover:text-ink max-sm:h-11 max-sm:w-11"
              >
                ×
              </button>
            </span>
          );
        })}
        {creator && (
          <span className="inline-flex items-center rounded-full bg-ink-wash px-2 py-0.5 text-[13px] text-ink" title="Valet adds this condition. It cannot be removed.">
            {creatorWords(mode, names)}
          </span>
        )}
        {!adding && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={fields.length === 0}
            className="h-auto px-1.5 py-0.5 text-[13px] font-normal text-accent-600 dark:text-accent-400"
            onClick={() => setAdding(true)}
          >
            + Add a condition
          </Button>
        )}
      </div>
      <p className="mt-1.5 text-xs text-muted">
        {draft.events.size === 0 ? "Pick an event first. Its fields become the conditions you can add." : conditionHint(service)}
      </p>
      {adding && (
        <AddCondition
          fields={fields}
          rows={[...draft.conditions]}
          onAdd={(row) => {
            onChange(addCondition(draft, row));
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {mention && !scoped && (
        <label className="mt-2 flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={draft.anyChannel}
            onChange={(e) => onChange({ ...draft, anyChannel: e.target.checked })}
          />
          <span>
            Any channel
            <span className="block text-xs text-muted">Add a channel condition, or choose this to listen in every channel the app can see.</span>
          </span>
        </label>
      )}
    </div>
  );
}

const ADD_OPS: readonly { value: FilterOp; label: string }[] = [
  { value: "eq", label: "is" },
  { value: "in", label: "is one of" },
  { value: "prefix", label: "starts with" },
  { value: "contains", label: "contains" },
];

/** The small picker behind `+ Add a condition`: a field these events carry, how it compares, and a value. */
function AddCondition({ fields, rows, onAdd, onCancel }: {
  fields: FilterField[];
  rows: UiFilterRow[];
  onAdd: (row: UiFilterRow) => void;
  onCancel: () => void;
}) {
  const [field, setField] = useState(fields[0]?.field ?? "");
  const [op, setOp] = useState<FilterOp>("eq");
  const [value, setValue] = useState("");
  const [label, setLabel] = useState<string | undefined>(undefined);
  // The offered fields follow the picked events; a field no longer offered
  // falls back to the first one.
  const firstField = fields[0]?.field ?? "";
  const offered = fields.some((f) => f.field === field);
  useEffect(() => {
    if (!offered) {
      setField(firstField);
      setValue("");
      setLabel(undefined);
    }
  }, [offered, firstField]);
  const selected = fields.find((f) => f.field === field);
  const source = op === "in" ? undefined : selected?.options;
  const deps: Record<string, string> = {};
  for (const dep of source?.dependsOn ?? []) {
    const sibling = rows.find((r) => r.field === dep && r.value.trim().length > 0);
    if (sibling) deps[dep] = sibling.value.trim();
  }
  return (
    <div className="mt-2 grid gap-2 rounded-lg border border-line p-3">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.4fr)]">
        <select
          aria-label="Condition field"
          value={field}
          onChange={(e) => {
            setField(e.target.value);
            setValue("");
            setLabel(undefined);
          }}
          className="min-h-11 min-w-0 rounded border border-line bg-paper px-2 py-1.5 text-sm text-ink sm:min-h-0"
        >
          {fields.map((f) => <option key={f.field} value={f.field}>{fieldLabel(f.field)}</option>)}
        </select>
        <select
          aria-label="Condition comparison"
          value={op}
          onChange={(e) => {
            const next = ADD_OPS.find((o) => o.value === e.target.value);
            if (next) setOp(next.value);
          }}
          className="min-h-11 rounded border border-line bg-paper px-2 py-1.5 text-sm text-ink sm:min-h-0"
        >
          {ADD_OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {source !== undefined ? (
          <FilterValuePicker
            source={source.source}
            dependsOn={source.dependsOn}
            deps={deps}
            value={value}
            label={label}
            onPick={(v, l) => {
              setValue(v);
              setLabel(l);
            }}
            onFreeText={(v) => {
              setValue(v);
              setLabel(undefined);
            }}
          />
        ) : (
          <Input
            aria-label="Condition value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={op === "in" ? "a, b, c" : "Value"}
            className="min-w-0"
          />
        )}
      </div>
      {selected?.description && <p className="text-xs text-muted">{selected.description}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button
          type="button"
          size="sm"
          disabled={field.length === 0 || value.trim().length === 0}
          onClick={() => onAdd({ id: crypto.randomUUID(), field, op, value: value.trim(), ...(label !== undefined ? { label } : {}) })}
        >
          Add
        </Button>
      </div>
    </div>
  );
}
