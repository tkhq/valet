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

  describe('the filters on an event trigger', () => {
    // A filter Valet reads only in part is worse than one it refuses: an
    // EMPTY filter list matches every event of its key, so a dropped entry
    // arms the subscription on every push in the org rather than on the one
    // repository the file named.
    function withFilters(filters: unknown): unknown {
      return {
        valet: WORKFLOW_FILE_KIND,
        definition: definition(),
        events: [{ name: 'On push', eventKeys: ['github.push'], filters }],
      };
    }

    it('refuses an op it does not read, and names the ops it does', () => {
      const result = parseWorkflowFileValue(
        withFilters([{ field: 'repo', op: 'equals', value: 'acme/service' }]),
        '.valet/workflows/push.yaml',
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('invalid');
      const message = result.errors.join(' ');
      expect(message).toContain('equals');
      expect(message).toContain('eq, in, prefix, contains');
      expect(message).toContain('events[0].filters[0]');
    });

    it('refuses a filter with no field to test', () => {
      const result = parseWorkflowFileValue(
        withFilters([{ op: 'eq', value: 'acme/service' }]),
        '.valet/workflows/push.yaml',
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('invalid');
      expect(result.errors.join(' ')).toContain('"field"');
    });

    it('refuses a filters block written as a mapping', () => {
      // The shape somebody writes who expects filters to be keyed by field.
      const result = parseWorkflowFileValue(
        withFilters({ repo: 'acme/service' }),
        '.valet/workflows/push.yaml',
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('invalid');
      const message = result.errors.join(' ');
      expect(message).toContain('a mapping');
      expect(message).toContain('list');
    });

    it('keeps a filter it can read whole', () => {
      const result = parseWorkflowFileValue(
        withFilters([{ field: 'repo', op: 'in', value: ['acme/service', 'acme/web'] }]),
        '.valet/workflows/push.yaml',
      );

      expect(result.ok).toBe(true);
      if (!result.ok || result.file.kind !== 'workflow') return;
      expect(result.file.events?.[0]?.filters).toEqual([
        { field: 'repo', op: 'in', value: ['acme/service', 'acme/web'] },
      ]);
    });
  });

  describe('a value that would make a message builder throw', () => {
    // YAML writes a value that refers to itself in two lines, with an anchor
    // and an alias. Every message builder that reaches for `JSON.stringify`
    // then throws on it — and a caller of this parser expects a result to
    // show, not an exception to catch.
    it('names the file when the valet key refers to itself', () => {
      const loop: Record<string, unknown> = {};
      loop.self = loop;

      const result = parseWorkflowFileValue(
        { valet: loop, definition: definition() },
        '.valet/workflows/anchor.yaml',
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('unknown-kind');
      expect(result.errors.join(' ')).toContain('.valet/workflows/anchor.yaml');
      expect(result.errors.join(' ')).toContain('a mapping');
    });

    it('names the file when a node refers to itself', () => {
      // Reached inside the validator, which names the offending value in
      // most of its errors and builds those names with `JSON.stringify`.
      const type: Record<string, unknown> = {};
      type.self = type;

      const result = parseWorkflowFileValue(
        {
          valet: WORKFLOW_FILE_KIND,
          definition: { version: 'dag/v1', nodes: [{ type }], edges: [] },
        },
        '.valet/workflows/node-anchor.yaml',
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('invalid');
      expect(result.errors.join(' ')).toContain('.valet/workflows/node-anchor.yaml');
      // The message names what to look for in the file, because the
      // underlying TypeError does not.
      expect(result.errors.join(' ')).toContain('anchor that refers to itself');
    });
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

    it('reads the gallery fields a template card renders', () => {
      const result = parseWorkflowFileValue(
        templateValue({ rank: 10, icon: '🌙', caveats: ['Reads public issues only.'] }),
        '.valet/templates/nightly.yaml',
      );

      expect(result.ok).toBe(true);
      if (!result.ok || result.file.kind !== 'template') return;
      expect(result.file.labeled).toBe(true);
      expect(result.file.template.id).toBe('acme-nightly-triage');
      expect(result.file.template.category).toBe('Daily digest');
      expect(result.file.template.apps).toEqual(['github', 'slack']);
      expect(result.file.template.steps).toEqual(['Read the open issues', 'Post a summary']);
      expect(result.file.template.rank).toBe(10);
      expect(result.file.template.icon).toBe('🌙');
      expect(result.file.template.caveats).toEqual(['Reads public issues only.']);
      expect(result.file.definition).toEqual(definition());
    });

    it('names every gallery field a template file leaves out', () => {
      const bare = templateValue();
      delete bare.category;
      delete bare.apps;
      delete bare.steps;

      const result = parseWorkflowFileValue(bare, '.valet/templates/thin.yaml');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('invalid');
      const message = result.errors.join(' ');
      expect(message).toContain('category');
      expect(message).toContain('apps');
      expect(message).toContain('steps');
    });

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
