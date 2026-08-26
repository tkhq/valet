/**
 * The workflow file envelope, and the one parser every source reads it
 * through: the import dialog, the repository sync, and the export route.
 *
 * `parseWorkflowFileValue` takes an ALREADY-PARSED value and holds no text
 * decoder, so the caller picks one — `yaml.parse` on the api, `JSON.parse`
 * plus a lazy YAML chunk in the browser. A decoder here would land in every
 * bundle that imports this module.
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
 * events:
 *   - name: On push
 *     eventKeys: [github.push]
 *     filters: [{ field: repo, op: eq, value: acme/service }]
 * ```
 *
 * A template file uses `valet: workflow-template/v1` and adds the gallery
 * fields a template card renders.
 */
import type {
  WorkflowTemplateEventFilter,
  WorkflowTemplateEventTrigger,
  WorkflowTemplateSchedule,
} from '@valet/engine';
import type { WorkflowDefinition } from './dag/shape.js';
import { validateWorkflowDefinition, type ValidateEnvironment } from './dag/validate.js';

/** The `valet:` value of a workflow definition file. */
export const WORKFLOW_FILE_KIND = 'workflow/v1';
/** The `valet:` value of a workflow template file. */
export const WORKFLOW_TEMPLATE_FILE_KIND = 'workflow-template/v1';

/** File extensions the repository sync reads. */
export const WORKFLOW_FILE_EXTENSIONS = ['.yaml', '.yml', '.json'] as const;

/** The gallery half of a template file: every `WorkflowTemplate` field except
 * the definition and the triggers, which the file carries beside it. */
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
  /** True when the file declared `valet: workflow/v1`; false for a shape that
   * predates the envelope. */
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
 *   - `unlabeled` — no `valet:` key, and not a shape that predates the
 *     envelope. A caller reading a folder the repository owns ignores this;
 *     a caller reading `.valet/workflows/` reports it.
 *   - `unknown-kind` — the `valet:` key names a kind this version cannot
 *     read. Always worth reporting.
 *   - `invalid` — the file claims to be a workflow and is wrong.
 */
export type WorkflowFileParseFailureCode = 'unlabeled' | 'unknown-kind' | 'invalid';

export type WorkflowFileParseResult =
  | { ok: true; file: WorkflowFile | WorkflowTemplateFile }
  | { ok: false; code: WorkflowFileParseFailureCode; errors: string[] };

/**
 * One already-parsed value → a workflow file, or the messages to show.
 * Returns a result for EVERY input and never throws: each caller has to put
 * a message on screen or into a per-file warning.
 *
 * `path` names the file in every message. `env` is the validator's
 * environment — the api passes the full one, the browser passes none, so a
 * file that parses in the browser can still be refused by the server.
 */
export function parseWorkflowFileValue(
  value: unknown,
  path: string,
  env: ValidateEnvironment = {},
): WorkflowFileParseResult {
  try {
    return readWorkflowFileValue(value, path, env);
  } catch (err) {
    // The message names both known causes because nothing here can tell them
    // apart: a null entry the validator dereferences, and a self-referential
    // YAML anchor its `JSON.stringify` calls choke on.
    const detail = err instanceof Error ? `: ${err.message}` : '';
    return {
      ok: false,
      code: 'invalid',
      errors: [
        `${path} could not be read${detail}.`,
        `Check that every entry under "nodes" and "edges" is a mapping and not empty. Then check the file for a YAML anchor that refers to itself.`,
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
 * `{ name, definition }`. A schedule or events block on one of them is read
 * as the labelled path reads it, because a caller can only report a block
 * this parser hands it.
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
  const triggers = readTriggers(value, path);
  if (!triggers.ok) return triggers.failure;
  const file: WorkflowFile = {
    kind: 'workflow',
    labeled: false,
    definition: candidate,
    ...optionalString('name', value.name),
    ...optionalString('description', value.description),
    ...triggers.value,
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

/** The optional `schedule` and `events` blocks, shape-checked only: the cron
 * expression and the filter FIELD names belong to the host that arms them.
 * A block this cannot read fails the file rather than being dropped, because
 * a trigger read in part fires on something the author did not ask for. */
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
        const filters = readFilters(raw.filters, `${path}: events[${index}]`, errors);
        read.push({
          name:
            typeof raw.name === 'string' && raw.name.trim() !== ''
              ? raw.name.trim()
              : raw.eventKeys.join(', '),
          eventKeys: raw.eventKeys,
          description: typeof raw.description === 'string' ? raw.description : '',
          ...(filters === undefined ? {} : { filters }),
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

/** The ops a filter may declare. The refusal message prints them. */
const FILTER_OPS: ReadonlyArray<WorkflowTemplateEventFilter['op']> = [
  'eq',
  'in',
  'prefix',
  'contains',
];

/**
 * The optional `filters` list. Every bad entry adds to `errors`, so one pass
 * names them all, and any of them FAILS the file: an empty filter list
 * matches EVERY event of its key, so a dropped entry would arm a
 * subscription on every push in the org instead of on the one repository the
 * author named.
 *
 * Which FIELDS an event key declares stays with the event catalog and
 * `validateSubscription`; a copy here would go stale.
 */
function readFilters(
  raw: unknown,
  label: string,
  errors: string[],
): WorkflowTemplateEventFilter[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    errors.push(
      `${label}: "filters" is ${describe(raw)}, and it must be a list. Write it as [{ field: repo, op: eq, value: acme/service }].`,
    );
    return undefined;
  }

  const filters: WorkflowTemplateEventFilter[] = [];
  raw.forEach((entry, index) => {
    const at = `${label}.filters[${index}]`;
    if (!isRecord(entry)) {
      errors.push(
        `${at} is ${describe(entry)}. Write each filter as a mapping with a "field" and an "op".`,
      );
      return;
    }
    if (typeof entry.field !== 'string' || entry.field.trim() === '') {
      errors.push(
        `${at} has no "field" to test. Name the event field to filter on, such as "repo".`,
      );
      return;
    }
    if (!isFilterOp(entry.op)) {
      errors.push(
        `${at} declares op: ${describe(entry.op)}, which Valet does not read. Use one of ${FILTER_OPS.join(', ')}.`,
      );
      return;
    }
    // A filter with no value tests nothing, so a value of the wrong shape
    // widens the subscription the same way a dropped entry does.
    const value = entry.value;
    if (value !== undefined && typeof value !== 'string' && !isStringArray(value)) {
      errors.push(
        `${at} declares value: ${describe(value)}, which Valet cannot match on. Write a string, or a list of strings.`,
      );
      return;
    }
    filters.push({
      field: entry.field.trim(),
      op: entry.op,
      ...(typeof value === 'string' || isStringArray(value) ? { value } : {}),
      ...(typeof entry.fromInput === 'string' ? { fromInput: entry.fromInput } : {}),
    });
  });
  return filters;
}

function isFilterOp(value: unknown): value is WorkflowTemplateEventFilter['op'] {
  return FILTER_OPS.some((op) => op === value);
}

/** The gallery fields. One failure names every missing one. */
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

/** Structural narrowing only. The validator reads every field, so anything
 * wrong below the top level comes back as a validator error. */
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
 * A value as a message names it. Total on purpose: `JSON.stringify` was here,
 * and it throws on a value that refers to itself through a YAML anchor.
 */
function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'a mapping';
  if (typeof value === 'function') return 'a function';
  return String(value);
}
