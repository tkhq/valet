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
import { CODE_REVIEW_WORKFLOW_DEFINITION, enableCodeReview } from './code-review.js';
import { upsertGithubInstallation } from '../lib/db/github-installations.js';

// llm_maxoutput_warning is a non-blocking advisory; the publish gate filters it too.
function blockingErrors(errs: ReturnType<typeof validateDefinition>) {
  return errs.filter((e) => e.code !== 'llm_maxoutput_warning');
}

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

beforeEach(() => {
  getCredentialMock.mockReset();
  getCredentialMock.mockResolvedValue({
    ok: true,
    credential: { accessToken: 'gho_caller', credentialType: 'oauth2', refreshed: false },
  });
});

describe('code-review workflow definition', () => {
  it('is a structurally valid dag/v1 definition', () => {
    const errs = blockingErrors(validateDefinition(CODE_REVIEW_WORKFLOW_DEFINITION));
    expect(errs, errs.map((e) => e.code).join(', ')).toEqual([]);
  });

  it('passes publish-time env validation once provider keys are configured', () => {
    // Mirrors the enable path (enableCodeReview -> publishDraft ->
    // validateAgainstEnvironment). With the provider key set, a clean definition
    // yields zero errors, so any llm_model_id_invalid / llm_provider_key_missing
    // turns this red — the gate that would catch a slash-form model id.
    const env = { ANTHROPIC_API_KEY: 'sk-ant-test' } as Env;
    const errs = validateAgainstEnvironment(CODE_REVIEW_WORKFLOW_DEFINITION, env);
    expect(errs, errs.map((e) => `${e.code}@${e.nodeId}`).join(', ')).toEqual([]);
  });
});

describe('enableCodeReview', () => {
  afterEach(() => vi.unstubAllGlobals());

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

  it('installs a published workflow and a github-app trigger scoped to the repo', async () => {
    const { db, env } = await setup();
    const result = await enableCodeReview(db as never, env, 'u1', 'tkhq', 'valet');
    expect(result).toMatchObject({ owner: 'tkhq', repo: 'valet', alreadyArmed: false });

    // A real, published workflow backs the trigger.
    const wf = db.select().from(workflows).all();
    expect(wf).toHaveLength(1);
    expect(wf[0].id).toBe(result.workflowId);
    expect(wf[0].publishedVersionId).toBeTruthy();
    expect(db.select().from(workflowDefinitionVersions).all()).toHaveLength(1);

    // The github-app trigger carries the repo scope + the events the App dispatch reads.
    const appTriggers = db.select().from(triggers).all().filter((t) => t.type === 'github-app');
    expect(appTriggers).toHaveLength(1);
    expect(appTriggers[0].workflowId).toBe(result.workflowId);
    expect(JSON.parse(appTriggers[0].config as string)).toMatchObject({
      type: 'github-app', owner: 'tkhq', repo: 'valet', events: ['pull_request', 'issue_comment'],
    });
    expect(JSON.parse(appTriggers[0].variableMapping as string)).toHaveProperty('pullNumber', '$.pull_request.number');
  });

  it('is idempotent — re-arming the same repo returns the existing trigger, no duplicate/500', async () => {
    const { db, env } = await setup();
    const first = await enableCodeReview(db as never, env, 'u1', 'tkhq', 'valet');
    const second = await enableCodeReview(db as never, env, 'u1', 'tkhq', 'valet');

    expect(first.alreadyArmed).toBe(false);
    expect(second.alreadyArmed).toBe(true);
    expect(second.triggerId).toBe(first.triggerId);
    expect(second.workflowId).toBe(first.workflowId);
    // No duplicate trigger, and no second workflow installed.
    expect(db.select().from(triggers).all().filter((t) => t.type === 'github-app')).toHaveLength(1);
    expect(db.select().from(workflows).all()).toHaveLength(1);
  });

  it('rolls the workflow back when the publish env/model gate rejects', async () => {
    // No ANTHROPIC_API_KEY -> publishDraft fails with llm_provider_key_missing.
    const { db, env } = await setup();
    delete (env as unknown as Record<string, unknown>).ANTHROPIC_API_KEY;
    await expect(enableCodeReview(db as never, env, 'u1', 'tkhq', 'valet')).rejects.toThrow();
    expect(db.select().from(workflows).all()).toEqual([]);
    expect(db.select().from(triggers).all()).toEqual([]);
  });

  it('rejects when the App is not installed on the owner (no rows created)', async () => {
    const { db, env } = await setup();
    await expect(enableCodeReview(db as never, env, 'u1', 'not-installed', 'repo')).rejects.toThrow(/not installed/i);
    expect(db.select().from(workflows).all()).toEqual([]);
    expect(db.select().from(triggers).all()).toEqual([]);
  });

  it('rejects arming a repo the caller can only read', async () => {
    const { db, env } = await setup();
    stubGithubRepo({ push: false, pull: true });
    await expect(enableCodeReview(db as never, env, 'u1', 'tkhq', 'valet')).rejects.toThrow(/write access/i);
    expect(db.select().from(workflows).all()).toEqual([]);
    expect(db.select().from(triggers).all()).toEqual([]);
  });

  it('rejects arming a repo GitHub will not show the caller', async () => {
    const { db, env } = await setup();
    stubGithubRepo(null, 404);
    await expect(enableCodeReview(db as never, env, 'u1', 'tkhq', 'valet')).rejects.toThrow(/do not have access/i);
    expect(db.select().from(workflows).all()).toEqual([]);
  });

  it('rejects when the caller has not linked a GitHub account', async () => {
    const { db, env } = await setup();
    getCredentialMock.mockResolvedValue({ ok: false, error: { service: 'github', reason: 'not_found', message: 'none' } });
    await expect(enableCodeReview(db as never, env, 'u1', 'tkhq', 'valet')).rejects.toThrow(/Connect your own GitHub account/i);
    expect(db.select().from(workflows).all()).toEqual([]);
  });
});
