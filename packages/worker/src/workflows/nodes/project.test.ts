import { describe, it, expect } from 'vitest';
import { executeProject } from './project.js';
import type { ProjectNode, WorkflowDagState } from '@valet/shared';
import type { NodeExecutorArgs } from '../types.js';

function makeState(nodeData: unknown): WorkflowDagState {
  return {
    trigger: { data: {}, metadata: {}, type: 'manual', timestamp: new Date(0).toISOString() },
    nodes: {
      query: {
        status: 'completed',
        data: nodeData,
        startedAt: new Date(0).toISOString(),
        completedAt: new Date(0).toISOString(),
      },
    },
  } as WorkflowDagState;
}

function args(node: ProjectNode, state: WorkflowDagState): NodeExecutorArgs<ProjectNode> {
  return {
    node,
    state,
    aliases: undefined,
    params: {} as never,
    env: {} as never,
    step: {} as never,
    correlations: undefined,
    recordWaiting: undefined,
  } as unknown as NodeExecutorArgs<ProjectNode>;
}

describe('executeProject', () => {
  it('reshapes an array of records into a 2D array with a header row by default', async () => {
    const state = makeState({
      records: [
        { Account: { Name: 'Stripe', Website: 'stripe.com' }, Funding: 8700000000 },
        { Account: { Name: 'Ramp', Website: 'ramp.com' }, Funding: 1645000000 },
      ],
    });
    const node: ProjectNode = {
      id: 'rows',
      type: 'project',
      source: '{{nodes.query.data.records}}',
      columns: [
        { header: 'Account', path: 'Account.Name' },
        { header: 'Website', path: 'Account.Website' },
        { header: 'Funding', path: 'Funding' },
      ],
    };
    const result = await executeProject(args(node, state));
    expect(result).toEqual([
      ['Account', 'Website', 'Funding'],
      ['Stripe', 'stripe.com', 8700000000],
      ['Ramp', 'ramp.com', 1645000000],
    ]);
  });

  it('omits the header when includeHeader is false', async () => {
    const state = makeState({ records: [{ name: 'a' }, { name: 'b' }] });
    const result = await executeProject(args(
      {
        id: 'r',
        type: 'project',
        source: '{{nodes.query.data.records}}',
        includeHeader: false,
        columns: [{ header: 'N', path: 'name' }],
      },
      state,
    ));
    expect(result).toEqual([['a'], ['b']]);
  });

  it('substitutes default (or empty string) for missing dotted paths', async () => {
    const state = makeState({ records: [{ Account: { Name: 'Stripe' } }, {}] });
    const result = await executeProject(args(
      {
        id: 'r',
        type: 'project',
        source: '{{nodes.query.data.records}}',
        columns: [
          { header: 'Name', path: 'Account.Name' },
          { header: 'Funding', path: 'Account.Funding', default: 0 },
          { header: 'Vertical', path: 'Account.Vertical' }, // no default → empty string
        ],
      },
      state,
    ));
    expect(result).toEqual([
      ['Name', 'Funding', 'Vertical'],
      ['Stripe', 0, ''],
      ['', 0, ''],
    ]);
  });

  it('throws with a clear message when source resolves to a non-array', async () => {
    const state = makeState({ records: { not: 'an array' } });
    await expect(
      executeProject(args(
        {
          id: 'r',
          type: 'project',
          source: '{{nodes.query.data.records}}',
          columns: [{ header: 'X', path: 'x' }],
        },
        state,
      )),
    ).rejects.toThrow(/did not resolve to an array/);
  });
});
