/**
 * The settings form of a plugin event handler, made from its `configSchema`
 * (`PluginEventHandlerSummary` in `@valet/api/wire`). The Presence line
 * editor and the Code review page both show it.
 *
 * The form keeps only the settings that differ from the schema's defaults,
 * so a line follows a default that the plugin changes later. The server
 * checks the result against the schema on each save.
 */
import { useEffect, useId, useState } from "react";
import type { PluginSummary } from "@valet/api/wire";
import { pluginDisplayName } from "~/components/integrations/display-name";
import { Input, Label, Select, Switch, Textarea } from "~/components/primitives";
import { humanize } from "~/components/workflows/editor/steps-model";

/** One plugin event handler a reader may pick (`PluginEventHandlerSummary`). */
export interface HandlerOption {
  plugin: string;
  id: string;
  /** `PR review: Review pull request`. */
  label: string;
  description: string;
  events: string[];
  configSchema?: Record<string, unknown>;
}

/** Every event handler the plugins declare, in plugin order. */
export function handlerOptions(plugins: readonly PluginSummary[] | undefined): HandlerOption[] {
  return (plugins ?? []).flatMap((p) => (p.eventHandlers ?? []).map((h) => ({
    plugin: p.name,
    id: h.id,
    label: `${pluginDisplayName(p)}: ${humanize(h.id)}`,
    description: h.description,
    events: h.events,
    ...(h.configSchema !== undefined ? { configSchema: h.configSchema } : {}),
  })));
}

/** One setting the form can show. */
export type SettingsField = {
  key: string;
  label: string;
  description?: string;
} & (
  | { kind: "text"; default: string; multiline: boolean }
  | { kind: "list"; default: string[] }
  | { kind: "choice"; default: string; options: string[] }
  | { kind: "toggle"; default: boolean }
  | { kind: "number"; default: number | undefined; integer: boolean }
);

export type HandlerConfig = Record<string, unknown>;

/** A string field this long or longer gets a text area. */
const MULTILINE_FROM = 1000;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function choices(prop: Record<string, unknown>): string[] | null {
  if (Array.isArray(prop.enum) && prop.enum.every((v) => typeof v === "string")) return prop.enum as string[];
  const union = prop.anyOf ?? prop.oneOf;
  if (!Array.isArray(union)) return null;
  const consts = union.map((member) => record(member)?.const);
  return consts.every((v) => typeof v === "string") ? (consts as string[]) : null;
}

function field(key: string, prop: Record<string, unknown>): SettingsField | null {
  const base = {
    key,
    label: typeof prop.title === "string" ? prop.title : humanize(key),
    ...(typeof prop.description === "string" ? { description: prop.description } : {}),
  };
  const options = choices(prop);
  if (options !== null && options.length > 0) {
    const fallback = options[0]!;
    return { ...base, kind: "choice", options, default: typeof prop.default === "string" && options.includes(prop.default) ? prop.default : fallback };
  }
  switch (prop.type) {
    case "string":
      return {
        ...base,
        kind: "text",
        default: typeof prop.default === "string" ? prop.default : "",
        multiline: typeof prop.maxLength === "number" && prop.maxLength >= MULTILINE_FROM,
      };
    case "boolean":
      return { ...base, kind: "toggle", default: prop.default === true };
    case "number":
    case "integer":
      return { ...base, kind: "number", integer: prop.type === "integer", default: typeof prop.default === "number" ? prop.default : undefined };
    case "array": {
      if (record(prop.items)?.type !== "string") return null;
      const fallback = Array.isArray(prop.default) ? prop.default.filter((v): v is string => typeof v === "string") : [];
      return { ...base, kind: "list", default: fallback };
    }
    default:
      return null;
  }
}

/**
 * The fields of an object schema, in its order, or null when one of them
 * has a shape the form cannot show. Then the settings stay editable only
 * through the API, and the form says so.
 */
export function settingsFields(schema: unknown): SettingsField[] | null {
  const root = record(schema);
  const properties = record(root?.properties);
  if (root?.type !== "object" || properties === null) return null;
  const fields: SettingsField[] = [];
  for (const [key, raw] of Object.entries(properties)) {
    const prop = record(raw);
    const parsed = prop === null ? null : field(key, prop);
    if (parsed === null) return null;
    fields.push(parsed);
  }
  return fields;
}

/** A JSON value with object keys sorted. The server stores settings as
 * `jsonb`, which reorders keys, so a comparison must ignore key order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const rec = record(value);
  if (rec === null) return value;
  return Object.fromEntries(Object.keys(rec).sort().map((key) => [key, canonical(rec[key])]));
}

/** True when two settings values are equal, whatever their key order. */
export function sameSettings(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

const same = sameSettings;

/** The value a field shows: the stored setting, else the default. */
function shown(f: SettingsField, config: HandlerConfig): unknown {
  return config[f.key] ?? f.default;
}

/** The config with one setting changed. A value equal to the default is removed. */
export function withSetting(config: HandlerConfig, f: SettingsField, value: unknown): HandlerConfig {
  const next = { ...config };
  if (value === undefined || same(value, f.default)) delete next[f.key];
  else next[f.key] = value;
  return next;
}

function listText(value: unknown): string {
  return Array.isArray(value) ? value.join("\n") : "";
}

function parseList(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

/** A list as one entry per line. The text is local, so a new empty line stays while the reader types. */
function ListField({ id, value, onChange, describedBy }: { id: string; value: string[]; onChange: (next: string[]) => void; describedBy?: string }) {
  const [text, setText] = useState(() => listText(value));
  useEffect(() => {
    if (!same(parseList(text), value)) setText(listText(value));
    // Only an outside change resyncs the text.
  }, [JSON.stringify(value)]);
  return (
    <Textarea
      id={id}
      rows={Math.min(Math.max(value.length + 1, 2), 8)}
      value={text}
      aria-describedby={describedBy}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseList(e.target.value));
      }}
      className="font-mono text-xs"
    />
  );
}

export function HandlerSettingsForm({
  schema,
  value,
  onChange,
  disabled = false,
}: {
  schema: unknown;
  value: HandlerConfig;
  onChange: (next: HandlerConfig) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const fields = settingsFields(schema);
  if (fields === null) {
    return <p className="text-xs text-muted">This handler's settings have no form. Change them through the API.</p>;
  }
  if (fields.length === 0) return <p className="text-xs text-muted">This handler has no settings.</p>;
  return (
    <div className="grid gap-3">
      {fields.map((f) => {
        const fieldId = `${id}-${f.key}`;
        const descId = f.description !== undefined || f.kind === "list" ? `${fieldId}-desc` : undefined;
        const current = shown(f, value);
        const set = (next: unknown) => onChange(withSetting(value, f, next));
        const hint = [f.description, f.kind === "list" ? "One per line." : undefined].filter(Boolean).join(" ");
        const description = hint.length > 0 && <p id={descId} className="text-xs text-muted">{hint}</p>;
        if (f.kind === "toggle") {
          return (
            <div key={f.key} className="grid gap-1">
              <div className="flex items-center gap-2">
                <Switch id={fieldId} checked={current === true} disabled={disabled} aria-describedby={descId} onCheckedChange={set} />
                <Label htmlFor={fieldId}>{f.label}</Label>
              </div>
              {description}
            </div>
          );
        }
        return (
          <div key={f.key} className="grid gap-1">
            <Label htmlFor={fieldId}>{f.label}</Label>
            {f.kind === "choice" ? (
              <Select id={fieldId} value={String(current)} disabled={disabled} aria-describedby={descId} onChange={(e) => set(e.target.value)} className="w-full">
                {f.options.map((option) => <option key={option} value={option}>{humanize(option)}</option>)}
              </Select>
            ) : f.kind === "list" ? (
              <ListField id={fieldId} value={Array.isArray(current) ? (current as string[]) : []} onChange={set} describedBy={descId} />
            ) : f.kind === "number" ? (
              <Input
                id={fieldId}
                type="number"
                step={f.integer ? 1 : "any"}
                value={typeof current === "number" ? String(current) : ""}
                disabled={disabled}
                aria-describedby={descId}
                onChange={(e) => set(e.target.value.trim() === "" ? undefined : Number(e.target.value))}
              />
            ) : f.multiline ? (
              <Textarea id={fieldId} rows={3} value={String(current)} disabled={disabled} aria-describedby={descId} onChange={(e) => set(e.target.value)} />
            ) : (
              <Input id={fieldId} value={String(current)} disabled={disabled} aria-describedby={descId} onChange={(e) => set(e.target.value)} />
            )}
            {description}
          </div>
        );
      })}
    </div>
  );
}
