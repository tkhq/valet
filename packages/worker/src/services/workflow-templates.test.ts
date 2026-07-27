import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// The repo-authority check resolves the CALLER'S own GitHub OAuth token; stub
// that one lookup so the tests exercise the real check (including its GitHub
// permissions read, stubbed on fetch below) without a credential fixture.
const getCredentialMock = vi.hoisted(() => vi.fn());
vi.mock('./credentials.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./credentials.js')>()),
  getCredential: getCredentialMock,
}));

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
    expect(gateActions).toEqual(['opened', 'reopened', 'ready_for_review']);
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

    // An empty or whitespace-only write-up must not reach create_review, whose
    // schema requires a non-empty body when event is COMMENT.
    expect(byId.has_review.type).toBe('if');
    expect(byId.has_review.conditions).toEqual([
      { left: 'nodes.review.data.response', dataType: 'string', operation: 'matchesRegex', right: '\\S' },
    ]);

    // Post a real pull-request review, not an issue comment: create_review
    // takes pullNumber and an explicit event, and never issueNumber.
    expect(byId.post.action).toBe('github.create_review');
    expect(byId.post.params.pullNumber).toBe('{{ trigger.data.pullNumber }}');
    expect(byId.post.params.issueNumber).toBeUndefined();
    expect(byId.post.params.event).toBe('COMMENT');
    // Schema-less LLM output is wrapped as { response }, so the body reads `.response`.
    expect(byId.post.params.body).toBe('{{ nodes.review.data.response }}');

    expect(def.edges).toEqual([
      { from: 'trigger', to: 'gate' },
      { from: 'gate', to: 'fetch_pr', fromOutput: 'true' },
      { from: 'fetch_pr', to: 'review' },
      { from: 'review', to: 'has_review' },
      { from: 'has_review', to: 'post', fromOutput: 'true' },
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

/**
 * Stubs the two network reads the install path can make: the models.dev catalog
 * (offline is fine — availability checks no-op with an empty catalog) and the
 * GET /repos/{owner}/{repo} permissions read behind the repo-authority check.
 */
function stubGithubRepo(permissions: Record<string, boolean> | null, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.startsWith('https://api.github.com/repos/')) {
      return new Response(JSON.stringify(permissions ? { permissions } : {}), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error('offline');
  }));
}

const PIN = { owner: 'tkhq', repo: 'valet' };

beforeEach(() => {
  getCredentialMock.mockReset();
  getCredentialMock.mockResolvedValue({
    ok: true,
    credential: { accessToken: 'gho_caller', credentialType: 'oauth2', refreshed: false },
  });
});

describe('installWorkflowTemplate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function setup(envOverrides: Record<string, string> = {}) {
    stubGithubRepo({ push: true });
    const { db } = createTestDb();
    db.insert(users).values({ id: 'u1', email: 'u@e.io' }).run();
    await upsertGithubInstallation(db as never, {
      githubInstallationId: '1', accountLogin: 'tkhq', accountId: 'a1',
      accountType: 'Organization', repositorySelection: 'all',
    });
    const env = { ENCRYPTION_KEY: 'k', ANTHROPIC_API_KEY: 'sk-test', ...envOverrides } as unknown as Env;
    return { db, env };
  }

  it('installs a real published workflow with a suffixed webhook trigger', async () => {
    const { db, env } = await setup();
    const result = await installWorkflowTemplate(db as never, env, 'u1', 'code-review', PIN);

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
    const { db, env } = await setup();
    delete (env as unknown as Record<string, unknown>).ANTHROPIC_API_KEY;

    await expect(installWorkflowTemplate(db as never, env, 'u1', 'code-review', PIN)).rejects.toThrow();
    expect(db.select().from(workflows).all()).toEqual([]);
    expect(db.select().from(triggers).all()).toEqual([]);
  });

  it('repeat installs do not collide on trigger path or name', async () => {
    const { db, env } = await setup();
    const a = await installWorkflowTemplate(db as never, env, 'u1', 'code-review', PIN);
    const b = await installWorkflowTemplate(db as never, env, 'u1', 'code-review', PIN);
    expect(a.trigger!.path).not.toBe(b.trigger!.path);
    expect(a.trigger!.name).not.toBe(b.trigger!.name);
  });

  it('pins the installed webhook trigger to the repository it was armed for', async () => {
    const { db, env } = await setup();
    await installWorkflowTemplate(db as never, env, 'u1', 'code-review', PIN);

    const row = db.select().from(triggers).all()[0];
    expect(JSON.parse(row.config as string).github).toEqual({
      codeReview: true, owner: 'tkhq', repo: 'valet',
    });
  });

  it('refuses to install a repo-scoped template without a repository', async () => {
    const { db, env } = await setup();
    await expect(installWorkflowTemplate(db as never, env, 'u1', 'code-review')).rejects.toThrow(/scoped to one repository/i);
    expect(db.select().from(workflows).all()).toEqual([]);
  });

  it('refuses to install for a repository the caller only has read access to', async () => {
    const { db, env } = await setup();
    stubGithubRepo({ push: false, pull: true });
    await expect(installWorkflowTemplate(db as never, env, 'u1', 'code-review', PIN)).rejects.toThrow(/write access/i);
    expect(db.select().from(workflows).all()).toEqual([]);
  });

  it('refuses to install for a repository GitHub will not show the caller', async () => {
    const { db, env } = await setup();
    stubGithubRepo(null, 404);
    await expect(installWorkflowTemplate(db as never, env, 'u1', 'code-review', PIN)).rejects.toThrow(/do not have access/i);
    expect(db.select().from(workflows).all()).toEqual([]);
  });

  it('refuses to install when the caller has not linked a GitHub account', async () => {
    const { db, env } = await setup();
    getCredentialMock.mockResolvedValue({ ok: false, error: { service: 'github', reason: 'not_found', message: 'none' } });
    await expect(installWorkflowTemplate(db as never, env, 'u1', 'code-review', PIN)).rejects.toThrow(/Connect your own GitHub account/i);
    expect(db.select().from(workflows).all()).toEqual([]);
  });

  it('rejects an unknown template id without creating rows', async () => {
    const { db, env } = await setup();
    await expect(installWorkflowTemplate(db as never, env, 'u1', 'nope', PIN)).rejects.toThrow();
    expect(db.select().from(workflows).all()).toEqual([]);
  });
});

describe('enableTemplateGithubApp', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function installed() {
    stubGithubRepo({ push: true });
    const { db } = createTestDb();
    db.insert(users).values({ id: 'u1', email: 'u@e.io' }).run();
    await upsertGithubInstallation(db as never, {
      githubInstallationId: '1', accountLogin: 'tkhq', accountId: 'a1',
      accountType: 'Organization', repositorySelection: 'all',
    });
    const env = { ENCRYPTION_KEY: 'k', ANTHROPIC_API_KEY: 'sk-test' } as unknown as Env;
    const res = await installWorkflowTemplate(db as never, env, 'u1', 'code-review', PIN);
    return { db, env, workflowId: res.workflowId };
  }

  it('creates a github-app trigger scoped to the repo when the App is installed', async () => {
    const { db, env, workflowId } = await installed();
    await upsertGithubInstallation(db as never, {
      githubInstallationId: '1', accountLogin: 'tkhq', accountId: 'a1',
      accountType: 'Organization', repositorySelection: 'all',
    });

    const result = await enableTemplateGithubApp(db as never, env, 'u1', 'code-review', workflowId, 'tkhq', 'valet');
    expect(result).toMatchObject({ owner: 'tkhq', repo: 'valet', alreadyArmed: false });

    const appTriggers = db.select().from(triggers).all().filter((t) => t.type === 'github-app');
    expect(appTriggers).toHaveLength(1);
    const config = JSON.parse(appTriggers[0].config as string);
    expect(config).toMatchObject({ type: 'github-app', owner: 'tkhq', repo: 'valet', events: ['pull_request', 'issue_comment'] });
    // Reuses the template's webhook mapping so App events map into trigger.data.
    expect(JSON.parse(appTriggers[0].variableMapping as string)).toHaveProperty('pullNumber', '$.pull_request.number');
  });

  it('is idempotent — re-arming the same repo returns the existing trigger, no duplicate/500', async () => {
    const { db, env, workflowId } = await installed();
    await upsertGithubInstallation(db as never, {
      githubInstallationId: '1', accountLogin: 'tkhq', accountId: 'a1',
      accountType: 'Organization', repositorySelection: 'all',
    });

    const first = await enableTemplateGithubApp(db as never, env, 'u1', 'code-review', workflowId, 'tkhq', 'valet');
    const second = await enableTemplateGithubApp(db as never, env, 'u1', 'code-review', workflowId, 'tkhq', 'valet');

    expect(first.alreadyArmed).toBe(false);
    expect(second.alreadyArmed).toBe(true);
    expect(second.triggerId).toBe(first.triggerId);
    // No duplicate row (the unique name index would otherwise throw).
    expect(db.select().from(triggers).all().filter((t) => t.type === 'github-app')).toHaveLength(1);
  });

  it('rejects when the App is not installed on the owner (no dead trigger)', async () => {
    const { db, env, workflowId } = await installed();
    await expect(
      enableTemplateGithubApp(db as never, env, 'u1', 'code-review', workflowId, 'not-installed', 'repo'),
    ).rejects.toThrow(/not installed/i);
    expect(db.select().from(triggers).all().filter((t) => t.type === 'github-app')).toEqual([]);
  });

  it('rejects arming a repo the caller cannot write to, even with the App installed', async () => {
    const { db, env, workflowId } = await installed();
    stubGithubRepo({ push: false, pull: true });
    await expect(
      enableTemplateGithubApp(db as never, env, 'u1', 'code-review', workflowId, 'tkhq', 'valet'),
    ).rejects.toThrow(/write access/i);
    expect(db.select().from(triggers).all().filter((t) => t.type === 'github-app')).toEqual([]);
  });

  it('rejects arming a repo GitHub will not show the caller', async () => {
    const { db, env, workflowId } = await installed();
    stubGithubRepo(null, 404);
    await expect(
      enableTemplateGithubApp(db as never, env, 'u1', 'code-review', workflowId, 'tkhq', 'valet'),
    ).rejects.toThrow(/do not have access/i);
    expect(db.select().from(triggers).all().filter((t) => t.type === 'github-app')).toEqual([]);
  });

  it('rejects when the caller does not own the workflow', async () => {
    const { db, env, workflowId } = await installed();
    await upsertGithubInstallation(db as never, {
      githubInstallationId: '1', accountLogin: 'tkhq', accountId: 'a1',
      accountType: 'Organization', repositorySelection: 'all',
    });
    await expect(
      enableTemplateGithubApp(db as never, env, 'someone-else', 'code-review', workflowId, 'tkhq', 'valet'),
    ).rejects.toThrow();
  });
});
