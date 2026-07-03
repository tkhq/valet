import { describe, it, expect, vi, afterEach } from 'vitest';
import { validateDefinition, validateAgainstEnvironment } from '../lib/workflow-dag/validator.js';
import type { Env } from '../env.js';
import { createTestDb } from '../test-utils/db.js';
import { users } from '../lib/schema/users.js';
import { workflows, triggers } from '../lib/schema/workflows.js';
import { workflowDefinitionVersions } from '../lib/schema/workflow-definition-versions.js';
import {
  listWorkflowTemplates,
  getWorkflowTemplate,
  templateRunInputs,
  installWorkflowTemplate,
  enableTemplateGithubApp,
} from './workflow-templates.js';
import { upsertGithubInstallation } from '../lib/db/github-installations.js';

// llm_maxoutput_warning is a non-blocking advisory; the publish gate filters it too.
function blockingErrors(errs: ReturnType<typeof validateDefinition>) {
  return errs.filter((e) => e.code !== 'llm_maxoutput_warning');
}

describe('workflow templates', () => {
  it('every template has a structurally valid dag/v1 definition', () => {
    for (const t of listWorkflowTemplates()) {
      const errs = blockingErrors(validateDefinition(t.definition));
      expect(errs, `template "${t.id}" invalid: ${errs.map((e) => e.code).join(', ')}`).toEqual([]);
    }
  });

  it('every template passes publish-time env validation once provider keys are configured', () => {
    // Mirrors the install path (installWorkflowTemplate -> publishDraft ->
    // validateAgainstEnvironment). With every provider key set, a clean template
    // yields zero errors, so any llm_model_id_invalid / llm_provider_key_missing
    // turns this red — the gate that would have caught the slash-form model id.
    const env = {
      ANTHROPIC_API_KEY: 'sk-ant-test',
      OPENAI_API_KEY: 'sk-openai-test',
      GOOGLE_API_KEY: 'test-key',
    } as Env;
    for (const t of listWorkflowTemplates()) {
      const errs = validateAgainstEnvironment(t.definition, env);
      expect(errs, `template "${t.id}": ${errs.map((e) => `${e.code}@${e.nodeId}`).join(', ')}`).toEqual([]);
    }
  });

  it('exposes a stable catalog with client-safe input metadata', () => {
    const templates = listWorkflowTemplates();
    expect(templates.length).toBeGreaterThan(0);
    for (const t of templates) {
      expect(t.id).toMatch(/^[a-z0-9-]+$/);
      expect(t.name).toBeTruthy();
      // Each card renders an app-logo chain + human-readable steps.
      expect(t.apps.length).toBeGreaterThan(0);
      expect(t.steps.length).toBeGreaterThan(0);
      // "Run now" inputs derive from the trigger dataSchema — single source of truth.
      const inputs = templateRunInputs(t);
      expect(inputs.length).toBeGreaterThan(0);
      for (const input of inputs) {
        expect(['string', 'number']).toContain(input.type);
        expect(input.label).toBeTruthy();
      }
    }
  });

  it('code-review card shows the github → claude → github app chain', () => {
    const t = getWorkflowTemplate('code-review');
    expect(t?.apps).toEqual(['github', 'claude', 'github']);
    expect(t?.steps).toHaveLength(3);
  });

  it('code-review template wires the expected PR-review pipeline', () => {
    const t = getWorkflowTemplate('code-review');
    expect(t).toBeDefined();
    const def = t!.definition;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byId = Object.fromEntries(def.nodes.map((n) => [n.id, n as any]));

    expect(byId.trigger.type).toBe('trigger');
    expect(byId.trigger.dataSchema.pullNumber.type).toBe('number');
    // `action` is in the invocation contract but hidden — so it's NOT a
    // manual-run form field, yet trigger-data validation accepts it on webhooks.
    expect(byId.trigger.dataSchema.action.hidden).toBe(true);
    expect(templateRunInputs(t!).map((i) => i.name)).not.toContain('action');

    // The gate short-circuits non-code events (closed/labeled/…) before the
    // LLM call, and lets manual runs (no action) through via the isEmpty arm.
    expect(byId.gate.type).toBe('if');
    expect(byId.gate.combinator).toBe('or');
    const gateActions = byId.gate.conditions.filter((c: { operation: string }) => c.operation === 'equals').map((c: { right: string }) => c.right);
    expect(gateActions).toEqual(['opened', 'reopened', 'synchronize', 'ready_for_review']);
    expect(byId.gate.conditions.some((c: { operation: string }) => c.operation === 'isEmpty')).toBe(true);

    // Fetch the PR *with* its diff — the whole point of a code review.
    expect(byId.fetch_pr.action).toBe('github.inspect_pull_request');
    expect(byId.fetch_pr.params.includePatch).toBe(true);

    // The reviewer is an LLM node with an explicit model (publish requires one).
    expect(byId.review.type).toBe('llm');
    expect(typeof byId.review.model).toBe('string');
    expect(byId.review.model.length).toBeGreaterThan(0);
    // References upstream output as `.data` (not the stale `.output`).
    expect(byId.review.prompt).toContain('{{ nodes.fetch_pr.data }}');

    // Post via create_comment, which takes issueNumber (not pullNumber).
    expect(byId.post.action).toBe('github.create_comment');
    expect(byId.post.params.issueNumber).toBe('{{ trigger.data.pullNumber }}');
    // Schema-less LLM output is wrapped as { response }, so the body reads `.response`.
    expect(byId.post.params.body).toBe('{{ nodes.review.data.response }}');

    expect(def.edges).toEqual([
      { from: 'trigger', to: 'gate' },
      { from: 'gate', to: 'fetch_pr', fromOutput: 'true' },
      { from: 'fetch_pr', to: 'review' },
      { from: 'review', to: 'post' },
    ]);
  });

  it('code-review webhook maps a native GitHub pull_request payload', () => {
    const t = getWorkflowTemplate('code-review');
    expect(t?.trigger?.variableMapping).toEqual({
      action: '$.action',
      owner: '$.repository.owner.login',
      repo: '$.repository.name',
      pullNumber: '$.pull_request.number',
    });
  });
});

describe('installWorkflowTemplate', () => {
  // Hermetic: resolveAvailableModels fetches a models.dev catalog — an offline
  // fetch leaves the catalog empty, which is safe (model-availability checks
  // no-op when the provider has no catalog models).
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function setup(envOverrides: Record<string, string> = {}) {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    const { db } = createTestDb();
    db.insert(users).values({ id: 'u1', email: 'u@e.io' }).run();
    const env = { ENCRYPTION_KEY: 'k', ANTHROPIC_API_KEY: 'sk-test', ...envOverrides } as unknown as Env;
    return { db, env };
  }

  it('installs a real published workflow with a suffixed webhook trigger', async () => {
    const { db, env } = setup();
    const result = await installWorkflowTemplate(db as never, env, 'u1', 'code-review');

    const wf = db.select().from(workflows).all();
    expect(wf).toHaveLength(1);
    expect(wf[0].id).toBe(result.workflowId);
    expect(wf[0].publishedVersionId).toBeTruthy();
    expect(db.select().from(workflowDefinitionVersions).all()).toHaveLength(1);

    expect(result.trigger).not.toBeNull();
    expect(result.trigger!.path).toMatch(/-[0-9a-f]{8}$/);
    expect(result.trigger!.name).toMatch(/\([0-9a-f]{8}\)$/);
    expect(result.trigger!.webhookToken).toBeTruthy();
  });

  it('rolls the workflow back when the publish env/model gate rejects', async () => {
    // No ANTHROPIC_API_KEY -> publishDraft fails with llm_provider_key_missing.
    const { db, env } = setup();
    delete (env as unknown as Record<string, unknown>).ANTHROPIC_API_KEY;

    await expect(installWorkflowTemplate(db as never, env, 'u1', 'code-review')).rejects.toThrow();
    expect(db.select().from(workflows).all()).toEqual([]);
    expect(db.select().from(triggers).all()).toEqual([]);
  });

  it('repeat installs do not collide on trigger path or name', async () => {
    const { db, env } = setup();
    const a = await installWorkflowTemplate(db as never, env, 'u1', 'code-review');
    const b = await installWorkflowTemplate(db as never, env, 'u1', 'code-review');
    expect(a.trigger!.path).not.toBe(b.trigger!.path);
    expect(a.trigger!.name).not.toBe(b.trigger!.name);
  });

  it('rejects an unknown template id without creating rows', async () => {
    const { db, env } = setup();
    await expect(installWorkflowTemplate(db as never, env, 'u1', 'nope')).rejects.toThrow();
    expect(db.select().from(workflows).all()).toEqual([]);
  });
});

describe('enableTemplateGithubApp', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function installed() {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const { db } = createTestDb();
    db.insert(users).values({ id: 'u1', email: 'u@e.io' }).run();
    const env = { ENCRYPTION_KEY: 'k', ANTHROPIC_API_KEY: 'sk-test' } as unknown as Env;
    const res = await installWorkflowTemplate(db as never, env, 'u1', 'code-review');
    return { db, workflowId: res.workflowId };
  }

  it('creates a github-app trigger scoped to the repo when the App is installed', async () => {
    const { db, workflowId } = await installed();
    await upsertGithubInstallation(db as never, {
      githubInstallationId: '1', accountLogin: 'tkhq', accountId: 'a1',
      accountType: 'Organization', repositorySelection: 'all',
    });

    const result = await enableTemplateGithubApp(db as never, 'u1', 'code-review', workflowId, 'tkhq', 'valet');
    expect(result).toMatchObject({ owner: 'tkhq', repo: 'valet' });

    const appTriggers = db.select().from(triggers).all().filter((t) => t.type === 'github-app');
    expect(appTriggers).toHaveLength(1);
    const config = JSON.parse(appTriggers[0].config as string);
    expect(config).toMatchObject({ type: 'github-app', owner: 'tkhq', repo: 'valet', events: ['pull_request'] });
    // Reuses the template's webhook mapping so App events map into trigger.data.
    expect(JSON.parse(appTriggers[0].variableMapping as string)).toHaveProperty('pullNumber', '$.pull_request.number');
  });

  it('rejects when the App is not installed on the owner (no dead trigger)', async () => {
    const { db, workflowId } = await installed();
    await expect(
      enableTemplateGithubApp(db as never, 'u1', 'code-review', workflowId, 'not-installed', 'repo'),
    ).rejects.toThrow(/not installed/i);
    expect(db.select().from(triggers).all().filter((t) => t.type === 'github-app')).toEqual([]);
  });

  it('rejects when the caller does not own the workflow', async () => {
    const { db, workflowId } = await installed();
    await upsertGithubInstallation(db as never, {
      githubInstallationId: '1', accountLogin: 'tkhq', accountId: 'a1',
      accountType: 'Organization', repositorySelection: 'all',
    });
    await expect(
      enableTemplateGithubApp(db as never, 'someone-else', 'code-review', workflowId, 'tkhq', 'valet'),
    ).rejects.toThrow();
  });
});
