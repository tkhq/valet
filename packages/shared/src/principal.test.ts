import { describe, expect, it } from 'vitest';
import {
  formatPrincipal,
  isOrchestratorSessionId,
  orchestratorSessionId,
  parseOrchestratorSessionId,
  parsePrincipal,
  userPrincipal,
} from './principal.js';

describe('principal', () => {
  it('formats and parses round-trip', () => {
    expect(formatPrincipal({ type: 'user', id: 'u1' })).toBe('user:u1');
    expect(formatPrincipal({ type: 'team', id: 't1' })).toBe('team:t1');
    expect(parsePrincipal('user:u1')).toEqual({ type: 'user', id: 'u1' });
    expect(parsePrincipal('org:default')).toEqual({ type: 'org', id: 'default' });
  });

  it('parses ids containing colons (opaque id tail)', () => {
    expect(parsePrincipal('user:a:b')).toEqual({ type: 'user', id: 'a:b' });
  });

  it('throws on malformed principals', () => {
    expect(() => parsePrincipal('user:')).toThrow();
    expect(() => parsePrincipal('robot:u1')).toThrow();
    expect(() => parsePrincipal('u1')).toThrow();
    expect(() => parsePrincipal('')).toThrow();
  });

  it('builds userPrincipal', () => {
    expect(userPrincipal('u1')).toEqual({ type: 'user', id: 'u1' });
  });

  it('builds orchestrator session ids', () => {
    expect(orchestratorSessionId({ type: 'user', id: 'u1' })).toBe('orchestrator:user:u1');
    expect(orchestratorSessionId({ type: 'team', id: 't1' })).toBe('orchestrator:team:t1');
  });

  it('detects orchestrator session ids (any format, prefix-based)', () => {
    expect(isOrchestratorSessionId('orchestrator:user:u1')).toBe(true);
    expect(isOrchestratorSessionId('orchestrator:u1')).toBe(true); // pre-migration legacy
    expect(isOrchestratorSessionId('sess-123')).toBe(false);
    expect(isOrchestratorSessionId(null)).toBe(false);
    expect(isOrchestratorSessionId(undefined)).toBe(false);
  });

  it('resolves the team-orchestrator alias by pure transform', async () => {
    const { resolveTeamOrchestratorAlias, teamOrchestratorAlias } = await import('./principal.js');
    expect(teamOrchestratorAlias('t1')).toBe('team-orchestrator-t1');
    expect(resolveTeamOrchestratorAlias('team-orchestrator-t1')).toBe('orchestrator:team:t1');
    expect(resolveTeamOrchestratorAlias('team-orchestrator-')).toBeNull();
    expect(resolveTeamOrchestratorAlias('orchestrator')).toBeNull();
    expect(resolveTeamOrchestratorAlias('sess-1')).toBeNull();
  });

  it('parses canonical orchestrator session ids', () => {
    expect(parseOrchestratorSessionId('orchestrator:user:u1')).toEqual({ type: 'user', id: 'u1' });
    expect(parseOrchestratorSessionId('orchestrator:team:t1')).toEqual({ type: 'team', id: 't1' });
    expect(parseOrchestratorSessionId('orchestrator:u1')).toBeNull(); // legacy → not parseable
    expect(parseOrchestratorSessionId('sess-123')).toBeNull();
  });
});
