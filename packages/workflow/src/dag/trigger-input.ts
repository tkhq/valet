/**
 * Resolve a run's caller-supplied input against a trigger's declared
 * dataSchema: merge defaults, then validate required fields, primitive
 * types, and enum membership. Pure — callers (api service, run modal)
 * decide how to surface the errors.
 */

import type { WorkflowInputDefinition } from './shape.js';

export interface TriggerInputError {
  field: string;
  message: string;
}

export interface ResolvedTriggerInput {
  input: Record<string, unknown>;
  errors: TriggerInputError[];
}

/** Collapse the `integer` alias to `number`. Call this before branching on
 * an input definition's type, so `integer` behaves identically to `number`
 * on every surface (validation, run form, template inputs). */
export function normalizeInputType(
  type: WorkflowInputDefinition['type'],
): Exclude<WorkflowInputDefinition['type'], 'integer'> {
  return type === 'integer' ? 'number' : type;
}

function matchesType(value: unknown, type: WorkflowInputDefinition['type']): boolean {
  switch (normalizeInputType(type)) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
  // The union is exhaustive at compile time only — schemas are unchecked
  // stored JSON, so an unrecognized type string reaches here at runtime.
  // Skip the type check (required/default/enum still apply) instead of
  // rejecting every value of a field this version can't classify.
  return true;
}

/** Extract the trigger node's declared input schema from a stored (unknown)
 * definition. Returns undefined when there is no trigger node or it declares
 * no schema — callers then skip input validation entirely. The cast at the
 * end is the usual unknown-JSON seam: the container shape was checked
 * structurally, and field *contents* are only ever read through
 * `resolveTriggerInput`, which type-checks each definition it uses. */
export function triggerDataSchema(
  definition: unknown,
): Record<string, WorkflowInputDefinition> | undefined {
  if (typeof definition !== 'object' || definition === null) return undefined;
  const def = definition as Record<string, unknown>;
  if (!Array.isArray(def.nodes)) return undefined;
  for (const node of def.nodes) {
    if (typeof node !== 'object' || node === null) continue;
    const n = node as Record<string, unknown>;
    if (n.type !== 'trigger') continue;
    const schema = n.dataSchema;
    if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return undefined;
    return schema as Record<string, WorkflowInputDefinition>;
  }
  return undefined;
}

export function resolveTriggerInput(
  schema: Record<string, WorkflowInputDefinition> | undefined,
  input: Record<string, unknown>,
): ResolvedTriggerInput {
  const resolved: Record<string, unknown> = { ...input };
  const errors: TriggerInputError[] = [];
  if (!schema) return { input: resolved, errors };

  for (const [field, def] of Object.entries(schema)) {
    if (resolved[field] === undefined && def.default !== undefined) {
      resolved[field] = def.default;
    }
    const value = resolved[field];
    if (value === undefined) {
      if (def.required) {
        errors.push({ field, message: `Missing required input "${field}". Provide a value.` });
      }
      continue;
    }
    if (!matchesType(value, def.type)) {
      // Report the canonical type: a schema that wrote `integer` still
      // takes any number, so the corrective action names `number`.
      const typeName = normalizeInputType(def.type);
      errors.push({
        field,
        message: `Input "${field}" must be a ${typeName}. Provide a ${typeName} value.`,
      });
      continue;
    }
    if (def.enum && def.enum.length > 0 && !def.enum.some((allowed) => allowed === value)) {
      errors.push({
        field,
        message: `Input "${field}" must be one of: ${def.enum.map((v) => JSON.stringify(v)).join(', ')}.`,
      });
    }
  }

  return { input: resolved, errors };
}
