import { describe, it, expect } from 'vitest';
import {
  channelScopeKey,
  telegramScopeKey,
  webManualScopeKey,
  slackScopeKey,
  githubPrScopeKey,
  apiScopeKey,
} from './scope-key.js';
import { userPrincipal } from './principal.js';

const u1 = userPrincipal('u1');

describe('channelScopeKey', () => {
  it('produces user:userId:channelType:channelId format', () => {
    expect(channelScopeKey(userPrincipal('user-1'), 'telegram', '12345')).toBe('user:user-1:telegram:12345');
  });

  it('works with any channel type', () => {
    expect(channelScopeKey(u1, 'slack', 'C123')).toBe('user:u1:slack:C123');
    expect(channelScopeKey(u1, 'discord', '456')).toBe('user:u1:discord:456');
  });

  it('produces team-prefixed keys for team principals', () => {
    expect(channelScopeKey({ type: 'team', id: 't1' }, 'slack', 'C1')).toBe('team:t1:slack:C1');
  });
});

describe('telegramScopeKey', () => {
  it('delegates to channelScopeKey', () => {
    const result = telegramScopeKey(userPrincipal('user-1'), '12345');
    expect(result).toBe('user:user-1:telegram:12345');
    // Should match channelScopeKey output
    expect(result).toBe(channelScopeKey(userPrincipal('user-1'), 'telegram', '12345'));
  });
});

describe('scope keys are byte-identical to the legacy user format', () => {
  it('webManualScopeKey', () => {
    expect(webManualScopeKey(u1, 'sess-1')).toBe('user:u1:manual:sess-1');
  });

  it('slackScopeKey', () => {
    expect(slackScopeKey(u1, 'T123', 'C456', '1234.5678')).toBe('user:u1:slack:T123:C456:1234.5678');
  });

  it('githubPrScopeKey', () => {
    expect(githubPrScopeKey(u1, 'owner/repo', 42)).toBe('user:u1:github:owner/repo:pr:42');
  });

  it('apiScopeKey', () => {
    expect(apiScopeKey(u1, 'idempotency-key-1')).toBe('user:u1:api:idempotency-key-1');
  });
});
