import { describe, expect, it } from 'vitest';
import { openGitHubLinkClaim, sealGitHubLinkClaim, type GitHubLinkClaim } from './github-link-claim.js';

const KEY = 'test-encryption-key';
const NOW = 1_800_000_000;

function claimFor(userId: string, exp = NOW + 300): GitHubLinkClaim {
  return {
    v: 1,
    userId,
    githubId: '42',
    login: 'octocat',
    name: null,
    avatarUrl: null,
    accessToken: 'ghu_token',
    refreshToken: null,
    expiresAt: null,
    exp,
  };
}

describe('GitHub link claim', () => {
  it('opens for the user it was issued to', async () => {
    const blob = await sealGitHubLinkClaim(claimFor('user-a'), KEY);
    const opened = await openGitHubLinkClaim(blob, KEY, 'user-a', NOW);
    expect(opened).toEqual({ ok: true, claim: claimFor('user-a') });
  });

  it('refuses a claim issued to a different user', async () => {
    const blob = await sealGitHubLinkClaim(claimFor('user-a'), KEY);
    expect(await openGitHubLinkClaim(blob, KEY, 'user-b', NOW)).toEqual({
      ok: false,
      status: 403,
      code: 'user_mismatch',
    });
  });

  it('refuses an expired claim', async () => {
    const blob = await sealGitHubLinkClaim(claimFor('user-a', NOW - 1), KEY);
    expect(await openGitHubLinkClaim(blob, KEY, 'user-a', NOW)).toMatchObject({ ok: false, code: 'claim_expired' });
  });

  it('refuses a claim sealed under another key or tampered with', async () => {
    const foreign = await sealGitHubLinkClaim(claimFor('user-a'), 'other-key');
    expect(await openGitHubLinkClaim(foreign, KEY, 'user-a', NOW)).toMatchObject({ ok: false, code: 'invalid_claim' });
    expect(await openGitHubLinkClaim('not-a-claim', KEY, 'user-a', NOW)).toMatchObject({ ok: false, code: 'invalid_claim' });
  });
});
