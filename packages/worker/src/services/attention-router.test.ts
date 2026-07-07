import { describe, expect, it } from 'vitest';
import { resolveAudience } from './attention-router.js';

const MEMBERS = ['alice', 'bob', 'carol'];

describe('resolveAudience', () => {
  it('user-owned events go to the owner only, never a channel', () => {
    for (const kind of ['notification', 'question', 'escalation', 'approval'] as const) {
      const audience = resolveAudience({ kind, owner: { type: 'user', id: 'alice' } }, MEMBERS);
      expect(audience.queueUserIds).toEqual(['alice']);
      expect(audience.postToTeamChannel).toBe(false);
    }
  });

  it('team-owned events fan out to every current member', () => {
    const audience = resolveAudience({ kind: 'notification', owner: { type: 'team', id: 't1' } }, MEMBERS);
    expect(audience.queueUserIds).toEqual(MEMBERS);
  });

  it('urgent team kinds also post to the team channel; plain notifications do not', () => {
    const info = resolveAudience({ kind: 'notification', owner: { type: 'team', id: 't1' } }, MEMBERS);
    expect(info.postToTeamChannel).toBe(false);

    for (const kind of ['question', 'escalation', 'approval'] as const) {
      const urgent = resolveAudience({ kind, owner: { type: 'team', id: 't1' } }, MEMBERS);
      expect(urgent.postToTeamChannel).toBe(true);
    }
  });

  it('membership is caller-supplied — an empty team means no recipients', () => {
    const audience = resolveAudience({ kind: 'escalation', owner: { type: 'team', id: 't1' } }, []);
    expect(audience.queueUserIds).toEqual([]);
    expect(audience.postToTeamChannel).toBe(true);
  });
});
