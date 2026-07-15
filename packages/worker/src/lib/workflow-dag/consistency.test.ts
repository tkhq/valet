/**
 * Schema-surface consistency guard.
 *
 * The `dag/v1` schema is described in several places that historically
 * drifted out of sync during PR #117:
 *
 *   1. `WORKFLOW_NODE_TYPES` / `FOREACH_BODY_NODE_TYPES` string constants.
 *   2. Per-node zod schemas (source of truth for structural validation).
 *   3. Shared TS `WorkflowNode` / `ForeachBodyNode` discriminated unions.
 *   4. `NODE_DOCS` registry (labels + per-field help).
 *   5. `NODE_DEFAULT_FACTORIES` (default-instance factories).
 *   6. `getWorkflowSchemaReference()` — the schema doc the copilot's
 *      system prompt + `workflows.schema` MCP action serve.
 *   7. `VALIDATION_CODES` registry.
 *
 * A missing entry in any one of these caused a real bug during that PR
 * (e.g. `project` was added to constants + zod but omitted from the
 * copilot doc for two commits before a review caught it). This test is
 * the guardrail: iterate the canonical list once, assert every derived
 * surface is present.
 *
 * The test is intentionally NOT strict about `required`/`optional`
 * field lists in the reference doc — those are a curated subset for
 * agent consumption. What we DO enforce: every node type appears
 * everywhere, and every emitted validation code has a registry entry.
 */

import { describe, it, expect } from 'vitest';
import {
  NODE_SCHEMAS_BY_TYPE,
  WORKFLOW_NODE_TYPES,
  FOREACH_BODY_NODE_TYPES,
} from './schema.js';
import { NODE_DOCS, createDefaultWorkflowNode } from '@valet/shared';
import { VALIDATION_CODES, validateDefinition } from './validator.js';
import { getWorkflowSchemaReference } from '../../services/workflow-schema-reference.js';

describe('schema surface consistency (all node types)', () => {
  for (const type of WORKFLOW_NODE_TYPES) {
    describe(`node type "${type}"`, () => {
      it('has a zod schema in NODE_SCHEMAS_BY_TYPE', () => {
        expect(NODE_SCHEMAS_BY_TYPE).toHaveProperty(type);
      });

      it('has a NODE_DOCS entry', () => {
        expect(NODE_DOCS).toHaveProperty(type);
        expect(NODE_DOCS[type as keyof typeof NODE_DOCS].label).toBeTruthy();
        expect(NODE_DOCS[type as keyof typeof NODE_DOCS].description).toBeTruthy();
      });

      it('has a factory that returns the correct shape (id + type)', () => {
        // Factories are editor-scaffolding: they emit placeholder nodes
        // that intentionally fail full zod validation (empty prompts,
        // empty column lists, etc.) so the UI can require the user to
        // fill fields. We only assert the discriminator + id here.
        const node = createDefaultWorkflowNode(type, `default_${type}`) as { id: string; type: string };
        expect(node.id).toBe(`default_${type}`);
        expect(node.type).toBe(type);
      });

      it('appears in getWorkflowSchemaReference().nodes', () => {
        const ref = getWorkflowSchemaReference();
        const entry = ref.nodes.find((n) => n.type === type);
        expect(entry, `getWorkflowSchemaReference() is missing node type "${type}" — add an entry to workflow-schema-reference.ts`).toBeDefined();
        // Required list must include id + type at minimum.
        expect(entry?.required).toEqual(expect.arrayContaining(['id', 'type']));
      });
    });
  }

  it('every foreach-body-eligible type is also body-eligible in the workflow-node union', () => {
    for (const type of FOREACH_BODY_NODE_TYPES) {
      expect(WORKFLOW_NODE_TYPES).toContain(type);
    }
  });

  it('getWorkflowSchemaReference().validNodeTypes matches the constant', () => {
    const ref = getWorkflowSchemaReference();
    expect(ref.validNodeTypes).toEqual(WORKFLOW_NODE_TYPES);
    expect(ref.foreachBodyTypes).toEqual(FOREACH_BODY_NODE_TYPES);
  });
});

describe('validation code registry coverage', () => {
  // Every code the validator can emit must be in VALIDATION_CODES so
  // isValidationWarning knows its severity. This drives home the
  // "warnings are a curated set" invariant: new codes default to error,
  // which is safe, but if the author intended a warning they must
  // register it explicitly.
  //
  // We exercise the validator with a handful of intentionally-broken
  // definitions to surface every code, then check registry coverage.
  // Not every code is reachable from these seeds (env-specific codes
  // like llm_provider_key_missing need an env), so the assertion is
  // one-directional: every code we see MUST be registered. Unregistered
  // codes surfaced by future test additions will fail this test.

  it('every code emitted by validateDefinition on a variety of broken definitions is registered', () => {
    const seedDefinitions: unknown[] = [
      null,                                                   // malformed_definition
      { version: 'dag/v1', nodes: 'x', edges: [] },           // malformed_definition
      { version: 'dag/v1', nodes: [{ id: 'a', type: 'bash' }], edges: [] }, // unknown_node_type
      {
        version: 'dag/v1',
        nodes: [
          { id: 'a', type: 'set', values: {} },
          { id: 'a', type: 'stop' },                          // duplicate_id
        ],
        edges: [{ from: 'a', to: 'a' }],                      // edge_self_loop
      },
      {
        version: 'dag/v1',
        nodes: [
          { id: 't', type: 'trigger', dataSchema: { xs: { type: 'string' } } },
          { id: 'l', type: 'foreach', items: '{{trigger.data.xs}}', body: { id: 'b', type: 'set', values: {} } },
        ],
        edges: [{ from: 't', to: 'l' }],                      // foreach_items_trigger_untyped
      },
      {
        version: 'dag/v1',
        nodes: [
          { id: 'p', type: 'project', source: '{{trigger.data.x}}', columns: [{ header: 'H', path: '.' }] },
        ],
        edges: [],                                             // project_column_path_malformed
      },
    ];
    const seen = new Set<string>();
    for (const def of seedDefinitions) {
      for (const issue of validateDefinition(def)) {
        seen.add(issue.code);
      }
    }
    const unregistered = [...seen].filter((code) => !(code in VALIDATION_CODES));
    expect(unregistered, `these codes were emitted by validateDefinition but are not in VALIDATION_CODES: ${unregistered.join(', ')}`).toEqual([]);
  });

  it('every registered code has a documented severity', () => {
    for (const [code, severity] of Object.entries(VALIDATION_CODES)) {
      expect(severity === 'warning' || severity === 'error', `${code} severity must be 'warning' or 'error'`).toBe(true);
    }
  });
});
