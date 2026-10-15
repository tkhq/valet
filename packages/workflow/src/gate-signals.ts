import type { RunSignal } from './store.js';

/** Untagged answers belong only to gates created before occurrence IDs. */
export function matchesGateOccurrence(signal: RunSignal, effects: Record<string, unknown> | undefined): boolean {
  const payload = signal.payload;
  const signalGateId = payload !== null && typeof payload === 'object' && 'gateId' in payload ? payload.gateId : undefined;
  const gateId = typeof effects?.gateId === 'string' ? effects.gateId : undefined;
  if (signalGateId !== gateId) return false;
  if (gateId === undefined && effects?.accountConsentResolved === true
    && payload !== null && typeof payload === 'object' && 'scope' in payload && payload.scope === 'team_account') {
    const approver = effects.approver;
    const generation = approver !== null && typeof approver === 'object' && 'shareGeneration' in approver ? approver.shareGeneration : undefined;
    return effects.provenance === 'shared_account' && typeof generation === 'string'
      && signal.signalId === `${signal.signalType}:account:${generation}:resolution`;
  }
  return true;
}

/** Preview releases could re-park the same account after consuming consent. */
export function isLegacyAccountConsentLoop(signal: RunSignal, effects: Record<string, unknown> | undefined): boolean {
  return signal.consumedAt !== undefined && effects?.accountConsentResolved === true && typeof effects.gateId !== 'string'
    && effects.provenance === 'shared_account' && matchesGateOccurrence(signal, effects)
    && signal.payload !== null && typeof signal.payload === 'object' && 'scope' in signal.payload && signal.payload.scope === 'team_account';
}
