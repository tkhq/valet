import { describe, expect, it, vi, beforeEach } from 'vitest';

const getCredentialMock = vi.hoisted(() => vi.fn());
vi.mock('./credentials.js', () => ({ getCredential: getCredentialMock }));

const getInstallationMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/db/github-installations.js', () => ({
  getGithubInstallationByLogin: getInstallationMock,
}));

const loadGitHubAppMock = vi.hoisted(() => vi.fn());
const getOrMintInstallationTokenMock = vi.hoisted(() => vi.fn());
vi.mock('./github-app.js', () => ({
  loadGitHubApp: loadGitHubAppMock,
  getOrMintInstallationToken: getOrMintInstallationTokenMock,
}));

import {
  assertCallerCanAdministerRepo,
  assertExecutionCanUseAppForRepo,
  __resetRepoAuthorityCache,
} from './github-repo-authority.js';
import type { AppDb } from '../lib/drizzle.js';
import type { Env } from '../env.js';

const db = {} as AppDb;
const env = { ENCRYPTION_KEY: 'k' } as Env;

function stubRepoResponse(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  __resetRepoAuthorityCache();
  vi.unstubAllGlobals();
  getCredentialMock.mockReset();
  getInstallationMock.mockReset();
  getInstallationMock.mockResolvedValue({ id: 'i1', accountLogin: 'tkhq' });
  getCredentialMock.mockResolvedValue({
    ok: true,
    credential: { accessToken: 'gho_caller', credentialType: 'oauth2', refreshed: false },
  });
  loadGitHubAppMock.mockReset();
  getOrMintInstallationTokenMock.mockReset();
  // App unconfigured by default: the public-repo shortcut stays inert unless a
  // test opts in, so the existing cases still exercise the caller proof.
  loadGitHubAppMock.mockResolvedValue(null);
});

/** Configure the App so the public-repo visibility check can run. */
function stubAppConfigured() {
  loadGitHubAppMock.mockResolvedValue({});
  getOrMintInstallationTokenMock.mockResolvedValue({ token: 'ghs_install', expiresAt: Date.now() + 3_600_000 });
}

describe('assertCallerCanAdministerRepo', () => {
  it('accepts a caller with push access', async () => {
    stubRepoResponse({ permissions: { push: true, admin: false } });
    await expect(assertCallerCanAdministerRepo(db, env, 'u1', 'tkhq', 'valet')).resolves.toBeUndefined();
  });

  it('accepts a caller with admin access', async () => {
    stubRepoResponse({ permissions: { push: false, admin: true } });
    await expect(assertCallerCanAdministerRepo(db, env, 'u1', 'tkhq', 'valet')).resolves.toBeUndefined();
  });

  it('asks GitHub with the caller\'s own token, never an installation token', async () => {
    const fetchMock = stubRepoResponse({ permissions: { push: true } });
    await assertCallerCanAdministerRepo(db, env, 'u1', 'tkhq', 'valet');

    expect(getCredentialMock).toHaveBeenCalledWith(env, 'user', 'u1', 'github');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/tkhq/valet');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gho_caller');
  });

  it('rejects when the App is not installed on the owner', async () => {
    getInstallationMock.mockResolvedValue(null);
    stubRepoResponse({ permissions: { admin: true } });
    await expect(assertCallerCanAdministerRepo(db, env, 'u1', 'tkhq', 'valet')).rejects.toThrow(/not installed/i);
  });

  it('rejects when the caller has no linked GitHub identity', async () => {
    getCredentialMock.mockResolvedValue({ ok: false, error: { service: 'github', reason: 'not_found', message: 'none' } });
    stubRepoResponse({ permissions: { admin: true } });
    await expect(assertCallerCanAdministerRepo(db, env, 'u1', 'tkhq', 'valet')).rejects.toThrow(/Connect your own GitHub account/i);
  });

  it('rejects on a 404 — the repository GitHub will not show the caller', async () => {
    stubRepoResponse({ message: 'Not Found' }, 404);
    await expect(assertCallerCanAdministerRepo(db, env, 'u1', 'tkhq', 'secret')).rejects.toThrow(/do not have access/i);
  });

  it('rejects on a 403', async () => {
    stubRepoResponse({ message: 'Forbidden' }, 403);
    await expect(assertCallerCanAdministerRepo(db, env, 'u1', 'tkhq', 'secret')).rejects.toThrow(/do not have access/i);
  });

  it('rejects read-only access', async () => {
    stubRepoResponse({ permissions: { pull: true, triage: true, push: false, admin: false } });
    await expect(assertCallerCanAdministerRepo(db, env, 'u1', 'tkhq', 'valet')).rejects.toThrow(/write access/i);
  });

  it('rejects a response with no permissions block at all', async () => {
    stubRepoResponse({ full_name: 'tkhq/valet' });
    await expect(assertCallerCanAdministerRepo(db, env, 'u1', 'tkhq', 'valet')).rejects.toThrow(/write access/i);
  });

  it('rejects when GitHub is unreachable rather than assuming access', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await expect(assertCallerCanAdministerRepo(db, env, 'u1', 'tkhq', 'valet')).rejects.toThrow(/GitHub unreachable/i);
  });
});

describe('assertExecutionCanUseAppForRepo (mint boundary)', () => {
  it('allows an identity with push access', async () => {
    stubRepoResponse({ permissions: { push: true } });
    await expect(assertExecutionCanUseAppForRepo(db, env, 'u1', 'tkhq', 'valet')).resolves.toEqual({ ok: true });
  });

  it('denies without throwing, so the resolver can report a credential failure', async () => {
    stubRepoResponse({ message: 'Not Found' }, 404);
    const verdict = await assertExecutionCanUseAppForRepo(db, env, 'u1', 'tkhq', 'secret');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toMatch(/do not have access/i);
  });

  it('denies when the identity has no linked GitHub account of its own', async () => {
    getCredentialMock.mockResolvedValue({ ok: false, error: { service: 'github', reason: 'not_found', message: 'none' } });
    stubRepoResponse({ permissions: { admin: true } });
    const verdict = await assertExecutionCanUseAppForRepo(db, env, 'u1', 'tkhq', 'valet');
    expect(verdict.ok).toBe(false);
  });

  it('reuses a decided verdict, so a workflow of many nodes costs one GitHub call', async () => {
    const fetchMock = stubRepoResponse({ permissions: { push: true } });
    await assertExecutionCanUseAppForRepo(db, env, 'u1', 'tkhq', 'valet');
    await assertExecutionCanUseAppForRepo(db, env, 'u1', 'tkhq', 'valet');
    await assertExecutionCanUseAppForRepo(db, env, 'u1', 'tkhq', 'valet');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keys the cache by identity and repo — a grant for one repo is not a grant for another', async () => {
    stubRepoResponse({ permissions: { push: true } });
    await assertExecutionCanUseAppForRepo(db, env, 'u1', 'tkhq', 'valet');

    stubRepoResponse({ message: 'Not Found' }, 404);
    const other = await assertExecutionCanUseAppForRepo(db, env, 'u1', 'tkhq', 'secret');
    const otherUser = await assertExecutionCanUseAppForRepo(db, env, 'u2', 'tkhq', 'valet');
    expect(other.ok).toBe(false);
    expect(otherUser.ok).toBe(false);
  });

  it('does not cache an unreachable-GitHub failure', async () => {
    const failing = vi.fn(async () => { throw new Error('network down'); });
    vi.stubGlobal('fetch', failing);
    const first = await assertExecutionCanUseAppForRepo(db, env, 'u1', 'tkhq', 'valet');
    expect(first.ok).toBe(false);

    stubRepoResponse({ permissions: { push: true } });
    await expect(assertExecutionCanUseAppForRepo(db, env, 'u1', 'tkhq', 'valet')).resolves.toEqual({ ok: true });
  });
});

describe('public repositories: anonymous App path needs no caller proof', () => {
  it('authorizes a public repo at the mint boundary with no linked identity', async () => {
    stubAppConfigured();
    getCredentialMock.mockResolvedValue({ ok: false, error: { service: 'github', reason: 'not_found', message: 'none' } });
    const fetchMock = stubRepoResponse({ private: false });

    const verdict = await assertExecutionCanUseAppForRepo(db, env, 'anon', 'tkhq', 'valet');
    expect(verdict).toEqual({ ok: true });
    // Anonymity: the caller's own GitHub token is never consulted for a public repo.
    expect(getCredentialMock).not.toHaveBeenCalled();
    // The visibility check speaks to GitHub with the App's installation token.
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/tkhq/valet');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ghs_install');
  });

  it('lets arming a public repo through without caller push/admin', async () => {
    stubAppConfigured();
    getCredentialMock.mockResolvedValue({ ok: false, error: { service: 'github', reason: 'not_found', message: 'none' } });
    stubRepoResponse({ private: false });
    await expect(assertCallerCanAdministerRepo(db, env, 'anon', 'tkhq', 'valet')).resolves.toBeUndefined();
  });

  it('still requires caller proof for a private repo even when the App is configured', async () => {
    stubAppConfigured();
    // Visibility check (App token) says private; caller proof (own token) says push.
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      const body = auth === 'Bearer ghs_install' ? { private: true } : { permissions: { push: true } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(assertExecutionCanUseAppForRepo(db, env, 'u1', 'tkhq', 'secret')).resolves.toEqual({ ok: true });
    expect(getCredentialMock).toHaveBeenCalledWith(env, 'user', 'u1', 'github');
  });

  it('falls back to caller proof when repo visibility cannot be confirmed', async () => {
    stubAppConfigured();
    getCredentialMock.mockResolvedValue({ ok: false, error: { service: 'github', reason: 'not_found', message: 'none' } });
    stubRepoResponse({ message: 'Not Found' }, 404);
    const verdict = await assertExecutionCanUseAppForRepo(db, env, 'anon', 'tkhq', 'secret');
    expect(verdict.ok).toBe(false);
  });
});
