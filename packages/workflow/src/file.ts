/**
 * The workflow file envelope — one shape for a workflow kept in a file,
 * and one parser that every source reads it through.
 *
 * The import dialog turns a file into a workflow: a pasted or uploaded file,
 * and a repository file the api hands back as text. The repository sync and
 * the export route are the two doors the 2026-08-24 workflows MVP design adds
 * on this same parser (`docs/specs/2026-08-24-workflows-mvp-design.md`, tasks
 * 5 and 9). A second parser anywhere in that set would drift into accepting a
 * shape the others refuse, and the author would learn about it from whichever
 * door they happened to use.
 *
 * ## Text stays out of this file
 *
 * `parseWorkflowFileValue` takes an ALREADY-PARSED value. It holds no text
 * decoder, so YAML and JSON both reach it through the same door: the api
 * composes it with `yaml.parse`, and the web composes it with `JSON.parse`
 * plus a dynamically imported YAML chunk. YAML 1.2 is a superset of JSON, so
 * one decoder answers both — but which decoder ran is the caller's business,
 * and putting either one here would drag it into every bundle.
 *
 * ## The envelope
 *
 * ```yaml
 * valet: workflow/v1
 * name: Nightly triage
 * description: Sweeps open issues and posts a summary.
 * definition:
 *   version: dag/v1
 *   nodes: [ ... ]
 *   edges: [ ... ]
 * schedule:
 *   name: Nightly
 *   cron: "0 3 * * *"
 *   timezone: UTC
 *   description: Every day at 03:00 UTC
 * events:
 *   - name: On push
 *     eventKeys: [github.push]
 *     filters: [{ field: repo, op: eq, value: acme/service }]
 *     description: When someone pushes to the service repository
 * ```
 *
 * A template file uses `valet: workflow-template/v1` and adds the gallery
 * fields a template card renders.
 *
 * ## The discriminator does real work
 *
 * A top-level `workflows/` folder belongs to the repository and may hold
 * anything, so a file there without a `valet:` key must be ignorable in
 * silence. Under `.valet/workflows/` the same file is a mistake worth
 * naming. This parser does not know which folder it is reading, so it
 * reports the difference as a `code` on the failure, and the caller decides
 * what to do about it.
 *
 * ## Two shapes predate the envelope
 *
 * The import dialog accepts a bare definition (what the editor's JSON view
 * shows) and `{ name, definition }` (what `GET /api/workflows/:id` answers
 * with). Both still parse, and both come back `labeled: false`, so the
 * repository collector can refuse a file that never claimed to be a workflow
 * while the dialog keeps accepting one somebody exported by hand.
 */
import type { WorkflowTemplateEventTrigger, WorkflowTemplateSchedule } from '@valet/engine';
import type { WorkflowDefinition } from './dag/shape.js';
import { validateWorkflowDefinition, type ValidateEnvironment } from './dag/validate.js';

/** The `valet:` value of a workflow definition file. */
export const WORKFLOW_FILE_KIND = 'workflow/v1';
/** The `valet:` value of a workflow template file. */
export const WORKFLOW_TEMPLATE_FILE_KIND = 'workflow-template/v1';

/**
 * File extensions the repository sync reads. YAML first, because a
 * hand-authored definition wants comments and multi-line prompt text; JSON
 * stays valid because YAML 1.2 parses it.
 */
export const WORKFLOW_FILE_EXTENSIONS = ['.yaml', '.yml', '.json'] as const;

/**
 * The gallery half of a template file: every `WorkflowTemplate` field except
 * the definition and the triggers, which the file carries beside it.
 */
export interface WorkflowTemplateFileMeta {
  id: string;
  name: string;
  description: string;
  category: string;
  apps: string[];
  steps: string[];
  rank?: number;
  icon?: string;
  caveats?: string[];
}

/** One workflow definition file. */
export interface WorkflowFile {
  kind: 'workflow';
  /** True when the file declared `valet: workflow/v1`. False for one of the
   * two shapes that predate the envelope. */
  labeled: boolean;
  name?: string;
  description?: string;
  definition: WorkflowDefinition;
  schedule?: WorkflowTemplateSchedule;
  events?: WorkflowTemplateEventTrigger[];
}

/** One workflow template file. */
export interface WorkflowTemplateFile {
  kind: 'template';
  /** Always true: a template has no shape that predates the envelope. */
  labeled: true;
  template: WorkflowTemplateFileMeta;
  definition: WorkflowDefinition;
  schedule?: WorkflowTemplateSchedule;
  events?: WorkflowTemplateEventTrigger[];
}

/**
 * Why a value is not a workflow file.
 *
 *   - `unlabeled` — no `valet:` key, and not one of the two shapes that
 *     predate the envelope. A caller reading a folder the repository owns
 *     ignores this; a caller reading `.valet/workflows/` reports it.
 *   - `unknown-kind` — the `valet:` key names a kind this version does not
 *     read. Always worth reporting: the author meant this file for Valet.
 *   - `invalid` — the file claims to be a workflow and is wrong. The errors
 *     are the validator's own wherever the graph is what is wrong.
 */
export type WorkflowFileParseFailureCode = 'unlabeled' | 'unknown-kind' | 'invalid';

export type WorkflowFileParseResult =
  | { ok: true; file: WorkflowFile | WorkflowTemplateFile }
  | { ok: false; code: WorkflowFileParseFailureCode; errors: string[] };

/**
 * One already-parsed value → a workflow file, or the messages to show.
 *
 * `path` names the file in every message, because the person who can fix it
 * is reading a repository and not this code.
 *
 * `env` is the validator's environment. The api passes the full one, so a
 * file naming an unknown model or an unknown tool service fails at sync with
 * the validator's own text instead of at run time inside a node. The browser
 * has no plugin catalog and passes none, so a file that parses there can
 * still be refused by the server.
 *
 * This function returns a result for EVERY input, and never throws. Its
 * callers are a sync that must record a per-file warning, an import dialog
 * that must show a message, and an export route; none of them has anything
 * to do with a value that arrives as an exception.
 */
export function parseWorkflowFileValue(
  value: unknown,
  path: string,
  env: ValidateEnvironment = {},
): WorkflowFileParseResult {
  try {
    return readWorkflowFileValue(value, path, env);
  } catch (err) {
    // Every branch below returns a result, and this catch is what makes that
    // true of the FUNCTION rather than of its branches. A message builder
    // reaches for `JSON.stringify` on a value the author wrote — the
    // validator does it in most of its errors — and a YAML anchor that
    // refers to itself makes that throw. Callers here show a result; one
    // handed a throw has no message to put on screen.
    const detail = err instanceof Error ? err.message : 'the parser could not read it';
    return {
      ok: false,
      code: 'invalid',
      errors: [
        `${path} could not be read: ${detail}. Check the file for a YAML anchor that refers to itself.`,
      ],
    };
  }
}

function readWorkflowFileValue(
  value: unknown,
  path: string,
  env: ValidateEnvironment,
): WorkflowFileParseResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      code: 'unlabeled',
      errors: [
        `${path} holds no workflow. A workflow file is a mapping with a "valet: ${WORKFLOW_FILE_KIND}" key and a "definition".`,
      ],
    };
  }

  const label = value.valet;
  if (label === undefined) return parseLegacyShape(value, path, env);
  if (typeof label !== 'string' || (label !== WORKFLOW_FILE_KIND && label !== WORKFLOW_TEMPLATE_FILE_KIND)) {
    return {
      ok: false,
      code: 'unknown-kind',
      errors: [
        `${path} declares valet: ${describe(label)}, which Valet does not read. Set it to ${WORKFLOW_FILE_KIND} for a workflow, or ${WORKFLOW_TEMPLATE_FILE_KIND} for a template.`,
      ],
    };
  }

  const definition = readDefinition(value.definition, path, env);
  if (!definition.ok) return definition.failure;
  const triggers = readTriggers(value, path);
  if (!triggers.ok) return triggers.failure;

  if (label === WORKFLOW_FILE_KIND) {
    const file: WorkflowFile = {
      kind: 'workflow',
      labeled: true,
      definition: definition.value,
      ...optionalString('name', value.name),
      ...optionalString('description', value.description),
      ...triggers.value,
    };
    return { ok: true, file };
  }

  const meta = readTemplateMeta(value, path);
  if (!meta.ok) return meta.failure;
  const file: WorkflowTemplateFile = {
    kind: 'template',
    labeled: true,
    template: meta.value,
    definition: definition.value,
    ...triggers.value,
  };
  return { ok: true, file };
}

/**
 * The two shapes that predate the envelope: a bare definition, and
 * `{ name, definition }`. Neither carries a schedule or events — a file that
 * arms a trigger has always had to say `valet:` first.
 */
function parseLegacyShape(
  value: Record<string, unknown>,
  path: string,
  env: ValidateEnvironment,
): WorkflowFileParseResult {
  const nested = isRecord(value.definition) ? value.definition : undefined;
  const candidate: unknown = nested ?? value;
  if (!isDefinitionShape(candidate)) {
    return {
      ok: false,
      code: 'unlabeled',
      errors: [
        `${path} holds no workflow definition. A definition carries "version", "nodes" and "edges" — add a "valet: ${WORKFLOW_FILE_KIND}" key with a "definition", or export one from a workflow.`,
      ],
    };
  }
  const result = validateWorkflowDefinition(candidate, env);
  if (!result.ok) return { ok: false, code: 'invalid', errors: result.errors };
  const name = typeof value.name === 'string' && value.name.trim() !== '' ? value.name.trim() : undefined;
  const file: WorkflowFile = {
    kind: 'workflow',
    labeled: false,
    definition: candidate,
    ...(name === undefined ? {} : { name }),
  };
  return { ok: true, file };
}

type Read<T> = { ok: true; value: T } | { ok: false; failure: WorkflowFileParseResult & { ok: false } };

function readDefinition(
  raw: unknown,
  path: string,
  env: ValidateEnvironment,
): Read<WorkflowDefinition> {
  if (!isDefinitionShape(raw)) {
    return {
      ok: false,
      failure: {
        ok: false,
        code: 'invalid',
        errors: [
          `${path} has no usable "definition". A definition carries "version", "nodes" and "edges" — export one from a workflow, or copy it from the editor's JSON view.`,
        ],
      },
    };
  }
  const result = validateWorkflowDefinition(raw, env);
  if (!result.ok) return { ok: false, failure: { ok: false, code: 'invalid', errors: result.errors } };
  return { ok: true, value: raw };
}

/** The optional `schedule` and `events` blocks, shape-checked only. The cron
 * expression and the filter fields are checked by the host that arms them,
 * so one file cannot pass here and fail there. */
function readTriggers(
  value: Record<string, unknown>,
  path: string,
): Read<{ schedule?: WorkflowTemplateSchedule; events?: WorkflowTemplateEventTrigger[] }> {
  const errors: string[] = [];
  let schedule: WorkflowTemplateSchedule | undefined;
  let events: WorkflowTemplateEventTrigger[] | undefined;

  if (value.schedule !== undefined) {
    const raw = value.schedule;
    if (!isRecord(raw) || typeof raw.cron !== 'string' || raw.cron.trim() === '') {
      errors.push(`${path}: "schedule" needs a "cron" expression, such as "0 3 * * *".`);
    } else {
      schedule = {
        name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : 'Schedule',
        cron: raw.cron.trim(),
        description: typeof raw.description === 'string' ? raw.description : '',
        ...(typeof raw.timezone === 'string' && raw.timezone.trim() !== ''
          ? { timezone: raw.timezone.trim() }
          : {}),
      };
    }
  }

  if (value.events !== undefined) {
    if (!Array.isArray(value.events)) {
      errors.push(`${path}: "events" is a list of event triggers. Write it as a YAML list.`);
    } else {
      const read: WorkflowTemplateEventTrigger[] = [];
      value.events.forEach((raw, index) => {
        if (!isRecord(raw) || !isStringArray(raw.eventKeys) || raw.eventKeys.length === 0) {
          errors.push(
            `${path}: events[${index}] needs an "eventKeys" list, such as [github.push].`,
          );
          return;
        }
        read.push({
          name:
            typeof raw.name === 'string' && raw.name.trim() !== ''
              ? raw.name.trim()
              : raw.eventKeys.join(', '),
          eventKeys: raw.eventKeys,
          description: typeof raw.description === 'string' ? raw.description : '',
          ...(Array.isArray(raw.filters) ? { filters: readFilters(raw.filters) } : {}),
        });
      });
      if (read.length > 0) events = read;
    }
  }

  if (errors.length > 0) return { ok: false, failure: { ok: false, code: 'invalid', errors } };
  return {
    ok: true,
    value: {
      ...(schedule === undefined ? {} : { schedule }),
      ...(events === undefined ? {} : { events }),
    },
  };
}

/**
 * Filters pass through with their shape checked and their vocabulary
 * unchecked. Which fields an event key declares is the event catalog's
 * answer, and `validateSubscription` on the host gives it — a second copy
 * here would go stale as the catalog grows.
 */
function readFilters(raw: unknown[]): WorkflowTemplateEventTrigger['filters'] {
  const filters: NonNullable<WorkflowTemplateEventTrigger['filters']> = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.field !== 'string') continue;
    const op = entry.op;
    if (op !== 'eq' && op !== 'in' && op !== 'prefix' && op !== 'contains') continue;
    filters.push({
      field: entry.field,
      op,
      ...(typeof entry.value === 'string' || isStringArray(entry.value)
        ? { value: entry.value }
        : {}),
      ...(typeof entry.fromInput === 'string' ? { fromInput: entry.fromInput } : {}),
    });
  }
  return filters;
}

/** The gallery fields. Every one is named in the failure, so an author fixes
 * a thin template file in one edit rather than in four. */
function readTemplateMeta(
  value: Record<string, unknown>,
  path: string,
): Read<WorkflowTemplateFileMeta> {
  const missing: string[] = [];
  const id = requiredString(value.id, 'id', missing);
  const name = requiredString(value.name, 'name', missing);
  const description = requiredString(value.description, 'description', missing);
  const category = requiredString(value.category, 'category', missing);
  const apps = isStringArray(value.apps) ? value.apps : (missing.push('apps'), []);
  const steps = isStringArray(value.steps) ? value.steps : (missing.push('steps'), []);

  if (missing.length > 0) {
    return {
      ok: false,
      failure: {
        ok: false,
        code: 'invalid',
        errors: [
          `${path} is missing the template ${missing.length === 1 ? 'field' : 'fields'} ${missing.join(', ')}. A template card needs all of them.`,
        ],
      },
    };
  }

  return {
    ok: true,
    value: {
      id,
      name,
      description,
      category,
      apps,
      steps,
      ...(typeof value.rank === 'number' ? { rank: value.rank } : {}),
      ...(typeof value.icon === 'string' ? { icon: value.icon } : {}),
      ...(isStringArray(value.caveats) ? { caveats: value.caveats } : {}),
    },
  };
}

/**
 * Structural narrowing to `WorkflowDefinition`. The validator reads every
 * field, so this only has to get the value past the type boundary without a
 * cast; anything wrong below the top level comes back as a validator error.
 */
function isDefinitionShape(value: unknown): value is WorkflowDefinition {
  if (!isRecord(value)) return false;
  return (
    typeof value.version === 'string' && Array.isArray(value.nodes) && Array.isArray(value.edges)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function requiredString(value: unknown, field: string, missing: string[]): string {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  missing.push(field);
  return '';
}

function optionalString(field: 'name' | 'description', value: unknown): Record<string, string> {
  return typeof value === 'string' && value.trim() !== '' ? { [field]: value.trim() } : {};
}

/**
 * A value as a message names it, with no quoting surprise for a number or a
 * list somebody wrote where a kind belongs.
 *
 * Total, deliberately. `JSON.stringify` was here and it throws on a value
 * that refers to itself, which a YAML anchor writes in two lines. A message
 * must never be the thing that fails.
 */
function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'a mapping';
  if (typeof value === 'function') return 'a function';
  return String(value);
}
