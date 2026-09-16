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
 */
import type { EventCatalogEntry } from "@valet/engine";
import { resolvePath } from "./match.js";

/** Longest template one field may store. Bounds render cost per delivery. */
export const MAX_PROMPT_TEMPLATE_CHARS = 4_000;
/** Longest body a rendered template delivers. Payload values are unbounded. */
export const MAX_RENDERED_PROMPT_CHARS = 8_000;

/** The heading above the rendered `systemPrompt` in the delivered body. */
const INSTRUCTIONS_HEADING = "Instructions for this subscription:";

/** The two optional template fields of an orchestrator subscription target. */
export interface EventPromptConfig {
  systemPrompt?: string;
  userPromptTemplate?: string;
}

/** True when this target configures at least one template. */
export function hasPromptConfig(config: EventPromptConfig): boolean {
  return config.systemPrompt !== undefined || config.userPromptTemplate !== undefined;
}

/** One `{{ name }}` placeholder. `[^{}]` keeps a nested brace out of a match,
 * so `{{ {{x}} }}` fails the balance check below rather than rendering. */
const PLACEHOLDER_RE = /\{\{([^{}]*)\}\}/g;

/** The names a template may use. Anything else is refused at write time. */
const VARIABLE_RE = /^(event\.(key|summary|body)|refs\.[A-Za-z0-9_-]+|payload\.[A-Za-z0-9_-]+)$/;

/** The fixed part of the variable set, for an error message that teaches. */
const VARIABLE_HELP =
  "Use event.key, event.summary, event.body, refs.<name>, or payload.<field>.";

/** The payload fields the events selected by this rule declare. */
function declaredPayloadFields(entries: EventCatalogEntry[]): string[] {
  const fields = new Set<string>();
  for (const entry of entries) {
    for (const filter of entry.filters) fields.add(filter.field);
  }
  return [...fields].sort();
}

/**
 * The refusal for one template field, or `null` when it is safe to store.
 * `entries` are the catalog entries the rule's `eventKeys` select, the same
 * set the filter validator checks a filter field against, so a template and a
 * filter address exactly the same payload fields.
 */
export function validatePromptTemplate(
  value: unknown,
  field: string,
  entries: EventCatalogEntry[],
): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return `${field} must be a non-empty string. Remove the field, or enter a template.`;
  }
  if (value.length > MAX_PROMPT_TEMPLATE_CHARS) {
    return `${field} is too long (max ${MAX_PROMPT_TEMPLATE_CHARS} characters). Shorten it.`;
  }

  const names: string[] = [];
  const remainder = value.replace(PLACEHOLDER_RE, (_match, name: string) => {
    names.push(name.trim());
    return "";
  });
  if (remainder.includes("{{") || remainder.includes("}}")) {
    return `${field} has an unclosed {{ }} placeholder. Close every placeholder.`;
  }

  const declared = declaredPayloadFields(entries);
  for (const name of names) {
    if (!VARIABLE_RE.test(name)) {
      return `${field} uses an unknown variable: {{${name}}}. ${VARIABLE_HELP}`;
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
 * The body this delivery submits. With no template configured it is
 * `values["event.body"]`, the exact string the dispatcher built, so the
 * default delivery path is untouched. A `userPromptTemplate` replaces that
 * body; a `systemPrompt` rides above whichever body was chosen, under a
 * heading that separates the standing instruction from the event itself.
 */
export function renderEventPrompt(
  config: EventPromptConfig,
  values: Record<string, string>,
): string {
  const defaultBody = values["event.body"] ?? "";
  if (!hasPromptConfig(config)) return defaultBody;

  const body =
    config.userPromptTemplate !== undefined ? render(config.userPromptTemplate, values) : defaultBody;
  const composed =
    config.systemPrompt !== undefined
      ? `${INSTRUCTIONS_HEADING}\n${render(config.systemPrompt, values)}\n\n---\n\n${body}`
      : body;
  return composed.slice(0, MAX_RENDERED_PROMPT_CHARS);
}
