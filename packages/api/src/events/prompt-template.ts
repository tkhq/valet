/**
 * Prompt templates for an orchestrator event subscription (TKAI-491).
 *
 * A subscription that routes to an assistant may carry two optional strings
 * on its target: `systemPrompt` (a standing instruction for this rule) and
 * `userPromptTemplate` (the event message the assistant reads). Both are
 * rendered here, at delivery time, over a fixed variable set drawn from the
 * normalized event. A rule that sets neither delivers the default body
 * byte-for-byte, so the delivery path is unchanged for every rule written
 * before this feature.
 *
 * The language is substitution and nothing else: one pass of
 * `{{ variable }}` replacement over a whitelist of names. There is no
 * expression syntax, no path walk into the payload, no function call, and no
 * recursion. A rendered value that itself contains `{{ ... }}` stays
 * literal, so payload text cannot smuggle in a variable. Unknown names are
 * refused at WRITE time, and the write-time check is what makes the renderer
 * total: at delivery an absent value renders as an empty string instead of
 * throwing a delivery into the retry path.
 *
 * The variable set (documented in
 * `docs/specs/2026-07-20-event-system-design.md`):
 *
 * | Variable            | Value                                            |
 * |---------------------|--------------------------------------------------|
 * | `event.key`         | the normalized event key                         |
 * | `event.summary`     | the one-line summary the source plugin wrote     |
 * | `event.body`        | the body the rule would deliver with no template |
 * | `refs.<name>`       | one scope ref (`repo`, `installation_id`, …)     |
 * | `payload.<field>`   | one catalog-declared filter field of the payload |
 *
 * `payload.<field>` reaches the payload ONLY through the catalog entry for
 * the event's own key, over the same `field` → `path` map the filters match
 * on. An undeclared field is not addressable, so a template cannot read an
 * unreviewed corner of a provider payload. No variable reaches session,
 * thread, or any other subscription's data.
 *
 * `systemPrompt` takes a narrower set: `event.key` and `refs.<name>` only.
 * A rendered instruction stands under a heading that presents it to the
 * assistant as the rule's own standing instruction. The summary, the default
 * body, and every payload field carry text that the sender of the event
 * wrote, and that text must not gain the authority of the heading. The write
 * gate refuses the wider names in that field, and `instructionValues` holds
 * the same line at render time.
 *
 * A `refs.<name>` is the one name nothing checks. Refs arrive on the
 * normalized event at runtime and no catalog entry declares them, so a
 * misspelled ref passes the write gate and renders as an empty string. The
 * spec and the form both say so.
 */
import type { EventCatalogEntry } from "@valet/engine";
import { resolvePath } from "./match.js";

/** Longest template one field may store. Bounds render cost per delivery. */
export const MAX_PROMPT_TEMPLATE_CHARS = 4_000;
/** Longest body a rendered template delivers. Payload values are unbounded. */
export const MAX_RENDERED_PROMPT_CHARS = 8_000;

/** The heading above the rendered `systemPrompt` in the delivered body. */
const INSTRUCTIONS_HEADING = "Instructions for this subscription:";

/** The two template fields. Each one takes its own variable set. */
export type PromptField = "systemPrompt" | "userPromptTemplate";

/** The two optional template fields of an orchestrator subscription target. */
export interface EventPromptConfig {
  systemPrompt?: string;
  userPromptTemplate?: string;
}

/** True when this target configures at least one template. */
export function hasPromptConfig(config: EventPromptConfig): boolean {
  return config.systemPrompt !== undefined || config.userPromptTemplate !== undefined;
}

/** One `{{ name }}` placeholder, for the render pass. `scanPlaceholders`
 * refuses at write time every brace pair this expression cannot read back,
 * so an accepted template renders exactly the placeholders the gate saw. */
const PLACEHOLDER_RE = /\{\{([^{}]*)\}\}/g;

/** The names `userPromptTemplate` may use. Anything else is refused. */
const VARIABLE_RE = /^(event\.(key|summary|body)|refs\.[A-Za-z0-9_-]+|payload\.[A-Za-z0-9_-]+)$/;

/** The names `systemPrompt` may use: the two that carry no event text. */
const INSTRUCTION_VARIABLE_RE = /^(event\.key|refs\.[A-Za-z0-9_-]+)$/;

/** The variable set of each field, for an error message that teaches. */
const VARIABLE_HELP: Record<PromptField, string> = {
  systemPrompt: "Use event.key or refs.<name>.",
  userPromptTemplate:
    "Use event.key, event.summary, event.body, refs.<name>, or payload.<field>.",
};

/** The payload fields the events selected by this rule declare. */
function declaredPayloadFields(entries: EventCatalogEntry[]): string[] {
  const fields = new Set<string>();
  for (const entry of entries) {
    for (const filter of entry.filters) fields.add(filter.field);
  }
  return [...fields].sort();
}

/**
 * The placeholder names in a template, or the refusal for one this module
 * cannot read. The scan runs left to right: `{{` opens a placeholder and the
 * next `}}` closes it. A `}}` with no open placeholder in front of it is
 * literal text, so a template may show the assistant a JSON shape such as
 * `{"a": {"b": 1}}` or quote the `{{ }}` syntax itself.
 */
function scanPlaceholders(value: string, field: PromptField): { names: string[] } | { error: string } {
  const names: string[] = [];
  let from = 0;
  for (;;) {
    const open = value.indexOf("{{", from);
    if (open === -1) return { names };
    const close = value.indexOf("}}", open + 2);
    if (close === -1) {
      return { error: `${field} has an unclosed {{ placeholder. Close it with }}.` };
    }
    const nextOpen = value.indexOf("{{", open + 2);
    if (nextOpen !== -1 && nextOpen < close) {
      return { error: `${field} nests one {{ }} placeholder in another. Remove the inner {{ }}.` };
    }
    names.push(value.slice(open + 2, close).trim());
    from = close + 2;
  }
}

/**
 * The refusal for one template field, or `null` when it is safe to store.
 * `entries` are the catalog entries the rule's `eventKeys` select, the same
 * set the filter validator checks a filter field against, so a template and a
 * filter address exactly the same payload fields.
 */
export function validatePromptTemplate(
  value: unknown,
  field: PromptField,
  entries: EventCatalogEntry[],
): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return `${field} must be a non-empty string. Remove the field, or enter a template.`;
  }
  if (value.length > MAX_PROMPT_TEMPLATE_CHARS) {
    return `${field} is too long (max ${MAX_PROMPT_TEMPLATE_CHARS} characters). Shorten it.`;
  }

  const scanned = scanPlaceholders(value, field);
  if ("error" in scanned) return scanned.error;

  const declared = declaredPayloadFields(entries);
  for (const name of scanned.names) {
    if (!VARIABLE_RE.test(name)) {
      return `${field} uses an unknown variable: {{${name}}}. ${VARIABLE_HELP[field]}`;
    }
    if (field === "systemPrompt" && !INSTRUCTION_VARIABLE_RE.test(name)) {
      return (
        `${field} cannot use {{${name}}}. An instruction must not carry text from the event. ` +
        `${VARIABLE_HELP.systemPrompt} Move the variable to userPromptTemplate.`
      );
    }
    if (name.startsWith("payload.")) {
      const payloadField = name.slice("payload.".length);
      if (!declared.includes(payloadField)) {
        return (
          `${field} uses {{${name}}}, which no event selected by eventKeys declares. ` +
          `Declared payload fields: ${declared.join(", ") || "none"}.`
        );
      }
    }
  }
  return null;
}

/**
 * The variable map one delivery renders against. Built from the normalized
 * event alone: its key, its summary, the body the rule would have delivered,
 * its refs, and the payload fields its catalog entry declares.
 */
export function buildPromptValues(args: {
  eventKey: string;
  summary: string;
  /** The body the delivery carries with no user template configured. */
  body: string;
  refs: Record<string, string>;
  payload: unknown;
  catalog: EventCatalogEntry[];
}): Record<string, string> {
  const values: Record<string, string> = {
    "event.key": args.eventKey,
    "event.summary": args.summary,
    "event.body": args.body,
  };
  for (const [name, value] of Object.entries(args.refs)) {
    if (typeof value === "string") values[`refs.${name}`] = value;
  }
  // One entry per key: the same lookup `filtersMatch` makes, so a template
  // and a filter read the same field through the same path.
  const entry = args.catalog.find((e) => e.key === args.eventKey);
  for (const filter of entry?.filters ?? []) {
    const raw = resolvePath(args.payload, filter.path);
    if (typeof raw === "string") values[`payload.${filter.field}`] = raw;
    else if (typeof raw === "number") values[`payload.${filter.field}`] = String(raw);
  }
  return values;
}

/** One pass of `{{ name }}` substitution. An absent value renders empty. */
function render(template: string, values: Record<string, string>): string {
  return template.replace(PLACEHOLDER_RE, (_match, name: string) => values[name.trim()] ?? "");
}

/**
 * The values an instruction renders over. Every name that carries text from
 * the sender of the event is dropped, so an instruction cannot be written by
 * the person who sent the event. The write gate refuses those names too;
 * this keeps the property when a row reaches the renderer another way.
 */
function instructionValues(values: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (INSTRUCTION_VARIABLE_RE.test(name)) kept[name] = value;
  }
  return kept;
}

/**
 * The body this delivery submits. With no template configured it is
 * `values["event.body"]`, the exact string the dispatcher built, so the
 * default delivery path is untouched. A `userPromptTemplate` replaces that
 * body; a `systemPrompt` rides above whichever body was chosen, under a
 * heading that separates the standing instruction from the event itself.
 */
export function renderEventPrompt(
  config: EventPromptConfig,
  values: Record<string, string>,
  /**
   * Called when the user template renders to nothing and the default body
   * stands in. The dispatcher logs the substitution, so a rule that names a
   * field its events do not carry is visible.
   */
  onEmptyRender?: () => void,
): string {
  const defaultBody = values["event.body"] ?? "";
  if (!hasPromptConfig(config)) return defaultBody;

  let body = defaultBody;
  if (config.userPromptTemplate !== undefined) {
    // A template can render empty even though the write gate accepted it: a
    // field one selected event declares is absent from another. An empty
    // body costs the assistant a turn and tells it nothing, so the default
    // body stands in and the caller reports it.
    const rendered = render(config.userPromptTemplate, values);
    if (rendered.trim().length === 0) onEmptyRender?.();
    else body = rendered;
  }
  const composed =
    config.systemPrompt !== undefined
      ? `${INSTRUCTIONS_HEADING}\n${render(config.systemPrompt, instructionValues(values))}\n\n---\n\n${body}`
      : body;
  return composed.slice(0, MAX_RENDERED_PROMPT_CHARS);
}
