/**
 * The workflow file envelope. One parser reads every source the import
 * dialog offers — a file somebody pastes or uploads, and a repository file
 * the api hands back as text. The repository sync and the export route read
 * through it once the 2026-08-24 workflows MVP design adds them (tasks 5 and
 * 9), so no two of the four can drift into accepting different shapes.
 *
 * These cases run on ALREADY-PARSED values. `parseWorkflowFileValue` takes no
 * text and holds no decoder, so YAML and JSON reach it through the same door
 * and neither can accept a shape the other refuses.
 */
import { describe, expect, it } from 'vitest';
import {
  parseWorkflowFileValue,
  WORKFLOW_FILE_KIND,
  WORKFLOW_TEMPLATE_FILE_KIND,
} from './file.js';
import type { WorkflowDefinition } from './dag/shape.js';

/** The smallest definition the validator accepts: one trigger, no edges. */
function definition(): WorkflowDefinition {
  return {
    version: 'dag/v1',
    nodes: [{ id: 'start', type: 'trigger' }],
    edges: [],
  };
}

describe('parseWorkflowFileValue', () => {
  it('reads an envelope, and keeps the triggers it declares', () => {
    const result = parseWorkflowFileValue(
      {
        valet: WORKFLOW_FILE_KIND,
        name: 'Nightly triage',
        description: 'Sweeps open issues and posts a summary.',
        definition: definition(),
        schedule: {
          name: 'Nightly',
          cron: '0 3 * * *',
          timezone: 'UTC',
          description: 'Every day at 03:00 UTC',
        },
        events: [
          {
            name: 'On push',
            eventKeys: ['github.push'],
            filters: [{ field: 'repo', op: 'eq', value: 'acme/service' }],
            description: 'When someone pushes to the service repository',
          },
        ],
      },
      '.valet/workflows/nightly.yaml',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.kind).toBe('workflow');
    if (result.file.kind !== 'workflow') return;
    expect(result.file.labeled).toBe(true);
    expect(result.file.name).toBe('Nightly triage');
    expect(result.file.description).toBe('Sweeps open issues and posts a summary.');
    expect(result.file.definition).toEqual(definition());
    expect(result.file.schedule).toEqual({
      name: 'Nightly',
      cron: '0 3 * * *',
      timezone: 'UTC',
      description: 'Every day at 03:00 UTC',
    });
    expect(result.file.events).toEqual([
      {
        name: 'On push',
        eventKeys: ['github.push'],
        filters: [{ field: 'repo', op: 'eq', value: 'acme/service' }],
        description: 'When someone pushes to the service repository',
      },
    ]);
  });

  it('leaves schedule and events unset when the file declares no trigger', () => {
    const value = {
      valet: WORKFLOW_FILE_KIND,
      name: 'By hand',
      definition: definition(),
    };

    const result = parseWorkflowFileValue(value, 'workflows/x.json');

    expect(result.ok).toBe(true);
    if (!result.ok || result.file.kind !== 'workflow') return;
    expect(result.file.schedule).toBeUndefined();
    expect(result.file.events).toBeUndefined();
    expect(result.file.definition).toEqual(definition());
  });

  describe('the shapes that shipped before the envelope', () => {
    it('accepts a bare definition, and marks it unlabeled', () => {
      const result = parseWorkflowFileValue(definition(), 'pasted.json');

      expect(result.ok).toBe(true);
      if (!result.ok || result.file.kind !== 'workflow') return;
      // `labeled` is what lets the repository collector refuse a file that
      // never claimed to be a workflow, while the import dialog accepts it.
      expect(result.file.labeled).toBe(false);
      expect(result.file.name).toBeUndefined();
      expect(result.file.definition).toEqual(definition());
    });

    it('accepts { name, definition }, which is what GET /api/workflows/:id answers', () => {
      const result = parseWorkflowFileValue(
        { name: 'Saved response', definition: definition() },
        'pasted.json',
      );

      expect(result.ok).toBe(true);
      if (!result.ok || result.file.kind !== 'workflow') return;
      expect(result.file.labeled).toBe(false);
      expect(result.file.name).toBe('Saved response');
    });
  });

  it('refuses an unknown valet kind by name', () => {
    const result = parseWorkflowFileValue(
      { valet: 'workflow/v2', definition: definition() },
      '.valet/workflows/future.yaml',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unknown-kind');
    expect(result.errors.join(' ')).toContain('workflow/v2');
    expect(result.errors.join(' ')).toContain('.valet/workflows/future.yaml');
    // The message names both kinds this version reads, so the author can fix
    // the file without reading the source.
    expect(result.errors.join(' ')).toContain(WORKFLOW_FILE_KIND);
    expect(result.errors.join(' ')).toContain(WORKFLOW_TEMPLATE_FILE_KIND);
  });

  it('reports a file that claims nothing and holds no definition', () => {
    // The repository collector ignores this in silence under a top-level
    // `workflows/` folder and warns under `.valet/workflows/`, so the two
    // cases are told apart by the code and not by the message.
    const result = parseWorkflowFileValue({ jobs: { build: {} } }, 'workflows/ci.yaml');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unlabeled');
  });

  it('reports a value that is not an object at all', () => {
    const result = parseWorkflowFileValue(['a', 'b'], 'workflows/list.yaml');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unlabeled');
    expect(result.errors.join(' ')).toContain('workflows/list.yaml');
  });

  it("hands back the validator's own errors for a bad graph", () => {
    const bad: unknown = {
      valet: WORKFLOW_FILE_KIND,
      name: 'Broken',
      definition: {
        version: 'dag/v1',
        nodes: [
          { id: 'start', type: 'trigger' },
          { id: 'note', type: 'set', values: {} },
        ],
        edges: [{ id: 'e1', from: 'start', to: 'nowhere' }],
      },
    };

    const result = parseWorkflowFileValue(bad, '.valet/workflows/broken.yaml');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid');
    // The validator names the edge and the missing endpoint. A summary in
    // its place would leave the author with nothing to act on.
    expect(result.errors.join(' ')).toContain('nowhere');
  });

  it('refuses an envelope whose definition is missing or the wrong shape', () => {
    const result = parseWorkflowFileValue(
      { valet: WORKFLOW_FILE_KIND, name: 'No graph' },
      '.valet/workflows/empty.yaml',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid');
    expect(result.errors.join(' ')).toContain('definition');
  });

  describe('a template file', () => {
    function templateValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        valet: WORKFLOW_TEMPLATE_FILE_KIND,
        id: 'acme-nightly-triage',
        name: 'Nightly triage',
        description: 'Sweeps open issues and posts a summary.',
        category: 'Daily digest',
        apps: ['github', 'slack'],
        steps: ['Read the open issues', 'Post a summary'],
        definition: definition(),
        ...overrides,
      };
    }

    it('validates the graph the same way a workflow file is validated', () => {
      const result = parseWorkflowFileValue(
        templateValue({ definition: { version: 'dag/v1', nodes: [], edges: [] } }),
        '.valet/templates/empty.yaml',
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('invalid');
      expect(result.errors.join(' ')).toContain('trigger');
    });
  });
});
