/**
 * `analyzeConcurrency` — the graph reading that lets the canvas say which
 * steps run at the same time.
 *
 * The load-bearing rule under test is that sharing a wave is NOT enough to
 * be concurrent: the two sides of an `if` land at the same depth and only
 * one of them ever runs, so they must never be grouped together.
 */
import { describe, expect, it } from 'vitest';
import { analyzeConcurrency, toFlow, type WorkflowDefinition } from './editor-model';

function flowOf(nodes: WorkflowDefinition['nodes'], edges: WorkflowDefinition['edges']) {
  return toFlow({ version: 'dag/v1', nodes, edges });
}

const trigger: WorkflowDefinition['nodes'][number] = { id: 'trigger', type: 'trigger' };

function step(id: string): WorkflowDefinition['nodes'][number] {
  return { id, type: 'set', values: {} };
}

function branch(id: string): WorkflowDefinition['nodes'][number] {
  return { id, type: 'if', conditions: [] };
}

describe('analyzeConcurrency waves', () => {
  it('gives a straight line one node per wave and no groups', () => {
    const model = analyzeConcurrency(
      flowOf([trigger, step('a'), step('b')], [
        { from: 'trigger', to: 'a' },
        { from: 'a', to: 'b' },
      ]),
    );

    expect(model.byNode.trigger?.wave).toBe(0);
    expect(model.byNode.a?.wave).toBe(1);
    expect(model.byNode.b?.wave).toBe(2);
    expect(model.groups).toEqual([]);
  });

  it('groups siblings that leave one node on the same output', () => {
    const model = analyzeConcurrency(
      flowOf([trigger, step('a'), step('b')], [
        { from: 'trigger', to: 'a' },
        { from: 'trigger', to: 'b' },
      ]),
    );

    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]?.wave).toBe(1);
    expect(model.groups[0]?.nodeIds).toEqual(['a', 'b']);
  });

  it('waits for the longest path, so a shortcut target is not a sibling', () => {
    // trigger -> a -> b AND trigger -> b. `b` cannot start with `a`,
    // because it also waits for `a`.
    const model = analyzeConcurrency(
      flowOf([trigger, step('a'), step('b')], [
        { from: 'trigger', to: 'a' },
        { from: 'a', to: 'b' },
        { from: 'trigger', to: 'b' },
      ]),
    );

    expect(model.byNode.a?.wave).toBe(1);
    expect(model.byNode.b?.wave).toBe(2);
    expect(model.groups).toEqual([]);
  });

  it('ignores an edge that names a node the definition does not have', () => {
    const model = analyzeConcurrency(
      flowOf([trigger, step('a')], [
        { from: 'trigger', to: 'a' },
        { from: 'trigger', to: 'ghost' },
      ]),
    );

    expect(model.byNode.trigger?.parallelOut).toBe(1);
    expect(model.groups).toEqual([]);
  });

  it('answers the same groups for the same graph', () => {
    const build = () =>
      analyzeConcurrency(
        flowOf([trigger, step('a'), step('b'), step('c')], [
          { from: 'trigger', to: 'a' },
          { from: 'trigger', to: 'b' },
          { from: 'trigger', to: 'c' },
        ]),
      );

    expect(build().groups).toEqual(build().groups);
    expect(build().groups[0]?.id).toBe('wave-1-0');
  });
});

describe('analyzeConcurrency exclusive branches', () => {
  it('never groups the two sides of an if', () => {
    const model = analyzeConcurrency(
      flowOf([trigger, branch('check'), step('yes'), step('no')], [
        { from: 'trigger', to: 'check' },
        { from: 'check', to: 'yes', fromOutput: 'true' },
        { from: 'check', to: 'no', fromOutput: 'false' },
      ]),
    );

    expect(model.byNode.yes?.wave).toBe(2);
    expect(model.byNode.no?.wave).toBe(2);
    expect(model.groups).toEqual([]);
  });

  it('groups two steps that leave an if on the SAME output', () => {
    const model = analyzeConcurrency(
      flowOf([trigger, branch('check'), step('yes'), step('also')], [
        { from: 'trigger', to: 'check' },
        { from: 'check', to: 'yes', fromOutput: 'true' },
        { from: 'check', to: 'also', fromOutput: 'true' },
      ]),
    );

    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]?.nodeIds).toEqual(['yes', 'also']);
  });

  it('keeps exclusivity through a step that follows a branch', () => {
    const model = analyzeConcurrency(
      flowOf([trigger, branch('check'), step('yes'), step('no'), step('after')], [
        { from: 'trigger', to: 'check' },
        { from: 'check', to: 'yes', fromOutput: 'true' },
        { from: 'check', to: 'no', fromOutput: 'false' },
        { from: 'yes', to: 'after' },
      ]),
    );

    // `after` inherits "check took true", so it is still exclusive with
    // `no` even though both sit at wave 3 and wave 2 respectively.
    expect(model.byNode.after?.wave).toBe(3);
    expect(model.groups).toEqual([]);
  });

  it('groups a branch step with an unconditional step, which are compatible', () => {
    const model = analyzeConcurrency(
      flowOf([trigger, branch('check'), step('side'), step('yes'), step('no'), step('later')], [
        { from: 'trigger', to: 'check' },
        { from: 'trigger', to: 'side' },
        { from: 'check', to: 'yes', fromOutput: 'true' },
        { from: 'check', to: 'no', fromOutput: 'false' },
        { from: 'side', to: 'later' },
      ]),
    );

    // Wave 1 holds check + side. Wave 2 holds yes, no and later: `yes`
    // needs check=true, `no` needs check=false, and `later` needs neither,
    // so `later` can join the first of them but the two sides stay apart.
    expect(model.groups.map((group) => group.nodeIds)).toEqual([
      ['check', 'side'],
      ['yes', 'later'],
    ]);
  });

  it('drops a decision that only some paths to a node take', () => {
    // Both sides of the branch reach `join`, so reaching `join` needs no
    // particular output. It therefore groups with `far`, which needs none
    // either — a node that inherited "check took true" would not.
    const model = analyzeConcurrency(
      flowOf(
        [
          trigger,
          branch('check'),
          step('yes'),
          step('no'),
          step('join'),
          step('near'),
          step('far'),
          step('farther'),
        ],
        [
          { from: 'trigger', to: 'check' },
          { from: 'check', to: 'yes', fromOutput: 'true' },
          { from: 'check', to: 'no', fromOutput: 'false' },
          { from: 'yes', to: 'join' },
          { from: 'no', to: 'join' },
          { from: 'trigger', to: 'near' },
          { from: 'near', to: 'far' },
          { from: 'far', to: 'farther' },
        ],
      ),
    );

    expect(model.byNode.join?.fanIn).toBe(2);
    expect(model.byNode.join?.wave).toBe(3);
    expect(model.byNode.farther?.wave).toBe(3);
    expect(model.groups.find((group) => group.wave === 3)?.nodeIds).toEqual(['join', 'farther']);
  });
});

describe('analyzeConcurrency counts', () => {
  it('counts targets on one output as parallel and distinct outputs as exclusive', () => {
    const model = analyzeConcurrency(
      flowOf([trigger, branch('check'), step('a'), step('b'), step('c')], [
        { from: 'trigger', to: 'check' },
        { from: 'check', to: 'a', fromOutput: 'true' },
        { from: 'check', to: 'b', fromOutput: 'true' },
        { from: 'check', to: 'c', fromOutput: 'false' },
      ]),
    );

    expect(model.byNode.check?.parallelOut).toBe(2);
    expect(model.byNode.check?.exclusiveOut).toBe(2);
  });

  it('counts every incoming edge as fan-in', () => {
    const model = analyzeConcurrency(
      flowOf([trigger, step('a'), step('b'), step('join')], [
        { from: 'trigger', to: 'a' },
        { from: 'trigger', to: 'b' },
        { from: 'a', to: 'join' },
        { from: 'b', to: 'join' },
      ]),
    );

    expect(model.byNode.join?.fanIn).toBe(2);
    expect(model.byNode.a?.fanIn).toBe(1);
    expect(model.byNode.trigger?.fanIn).toBe(0);
  });

  it('reports zero out-counts for a leaf', () => {
    const model = analyzeConcurrency(flowOf([trigger, step('a')], [{ from: 'trigger', to: 'a' }]));

    expect(model.byNode.a?.parallelOut).toBe(0);
    expect(model.byNode.a?.exclusiveOut).toBe(0);
  });
});
