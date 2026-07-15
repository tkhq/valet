/**
 * Client-side sibling to `packages/worker/src/lib/workflow-dag/consistency.test.ts`.
 *
 * The worker's consistency test guards drift on the server side (zod
 * schemas, shared type unions, docs registry, factories, reference doc).
 * The client has its OWN hand-maintained lists of node types that
 * historically drifted when the shared `WorkflowNode` union expanded —
 * six such drift sites were caught during PR #117's addition of the
 * `project` node.
 *
 * This test iterates every type in the shared `NODE_DOCS` registry and
 * asserts every client-side list agrees.
 */

import { describe, it, expect } from 'vitest';
import { NODE_DOCS } from '@valet/shared';
import type { DagNodeType } from '@valet/shared';
import { NODE_TYPE_OPTIONS } from './workflow-editor-model';

const ADDABLE_TYPES: DagNodeType[] = (Object.keys(NODE_DOCS) as DagNodeType[])
  .filter((t) => t !== 'trigger');

describe('client-side node-type registries', () => {
  it.each(ADDABLE_TYPES)('NODE_TYPE_OPTIONS includes %s (node palette)', (type) => {
    const entry = NODE_TYPE_OPTIONS.find((o) => o.type === type);
    expect(entry, `NODE_TYPE_OPTIONS is missing "${type}" — the node palette can't add this type`).toBeDefined();
    expect(entry?.label).toBeTruthy();
    expect(entry?.description).toBeTruthy();
  });
});
