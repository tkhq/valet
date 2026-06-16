import { describe, expect, it } from 'vitest';
import { signOAuthState, verifyOAuthState } from './oauth-state.js';

const SECRET = 'test-encryption-key-oauth-state';

describe('signOAuthState / verifyOAuthState', () => {
  it('round-trips: state minted for provider P verifies under P', async () => {
    const token = await signOAuthState(SECRET, 'slack-user', { userId: 'user-1' }, 600);
    const payload = await verifyOAuthState(SECRET, 'slack-user', token);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe('slack-user');
    expect(payload!.userId).toBe('user-1');
    expect(typeof payload!.jti).toBe('string');
    expect(typeof payload!.iat).toBe('number');
    expect(typeof payload!.exp).toBe('number');
    expect(payload!.exp - payload!.iat).toBe(600);
  });

  it('rejects when verifying with a different provider id (sub mismatch)', async () => {
    const token = await signOAuthState(SECRET, 'slack-user', { userId: 'user-1' });
    expect(await verifyOAuthState(SECRET, 'google_workspace', token)).toBeNull();
    expect(await verifyOAuthState(SECRET, 'slack', token)).toBeNull(); // close-but-wrong
  });

  it('rejects expired tokens', async () => {
    // Sign with ttl=0 so exp == iat == now; verify will see exp < now+epsilon.
    const token = await signOAuthState(SECRET, 'slack-user', { userId: 'user-1' }, 0);
    // Wait a bit to guarantee `now > exp`. We use a tight 1.1s wait so the test
    // stays fast but reliably crosses the second boundary used by exp.
    await new Promise((r) => setTimeout(r, 1100));
    expect(await verifyOAuthState(SECRET, 'slack-user', token)).toBeNull();
  });

  it('rejects tampered payload (signature breaks)', async () => {
    const token = await signOAuthState(SECRET, 'slack-user', { userId: 'user-1' }, 600);
    const [header, payload, sig] = token.split('.');
    expect(header).toBeTruthy();
    expect(payload).toBeTruthy();
    expect(sig).toBeTruthy();

    // Flip a single char in the payload section
    const tampered = `${header}.${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}.${sig}`;
    expect(await verifyOAuthState(SECRET, 'slack-user', tampered)).toBeNull();
  });

  it('rejects tampered signature', async () => {
    const token = await signOAuthState(SECRET, 'slack-user', { userId: 'user-1' }, 600);
    const [header, payload, sig] = token.split('.');
    const flipped = `${header}.${payload}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`;
    expect(await verifyOAuthState(SECRET, 'slack-user', flipped)).toBeNull();
  });

  it('rejects malformed tokens', async () => {
    expect(await verifyOAuthState(SECRET, 'slack-user', 'not.a.jwt')).toBeNull();
    expect(await verifyOAuthState(SECRET, 'slack-user', 'two.parts')).toBeNull();
    expect(await verifyOAuthState(SECRET, 'slack-user', '')).toBeNull();
    // @ts-expect-error – exercise runtime guard
    expect(await verifyOAuthState(SECRET, 'slack-user', undefined)).toBeNull();
  });

  it('rejects tokens signed with a different secret', async () => {
    const token = await signOAuthState(SECRET, 'slack-user', { userId: 'u1' });
    expect(await verifyOAuthState('different-secret', 'slack-user', token)).toBeNull();
  });

  it('embedded claims survive the round trip and do not collide with reserved keys', async () => {
    const token = await signOAuthState(
      SECRET,
      'slack-user',
      { userId: 'u1', returnTo: '/integrations', custom: { nested: true } },
      600,
    );
    const payload = await verifyOAuthState(SECRET, 'slack-user', token);
    expect(payload).not.toBeNull();
    expect(payload!.userId).toBe('u1');
    expect(payload!.returnTo).toBe('/integrations');
    expect((payload!.custom as { nested: boolean }).nested).toBe(true);
    // Reserved keys still take precedence
    expect(payload!.sub).toBe('slack-user');
  });
});
