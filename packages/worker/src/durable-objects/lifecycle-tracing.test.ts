import { describe, expect, it } from 'vitest';
import { lifecycleTaskAttributes, recoveryTraceTrigger, stopTraceTrigger } from './lifecycle-tracing.js';

describe('recoveryTraceTrigger', () => {
  it.each([
    ['sandbox_lost', 'runner_disconnect'],
    ['backoff_retry', 'backoff_retry'],
    ['ensure_running', 'ensure_running'],
    ['ensure_running_after_backoff', 'ensure_running'],
    ['refresh', 'refresh'],
    ['restore_failed: secret backend body', 'restore_failed'],
    ['spawn_failed: secret backend body', 'spawn_failed'],
    ['sandbox_wake_timeout', 'watchdog_timeout'],
    ['new-watchdog-reason: secret backend body', 'watchdog_timeout'],
  ])('maps %s to the safe %s trigger', (reason, expected) => {
    expect(recoveryTraceTrigger(reason)).toBe(expected);
  });
});

describe('lifecycleTaskAttributes', () => {
  it('uses stable lifecycle attributes without passing through dynamic recovery reasons', () => {
    expect(lifecycleTaskAttributes({
      sessionId: 'session-1',
      userId: 'user-1',
      statusFrom: 'restoring',
      trigger: recoveryTraceTrigger('restore_failed: secret backend body'),
      recoveryAttempt: 2,
    })).toEqual({
      'valet.session.id': 'session-1',
      'valet.user.id': 'user-1',
      'valet.session.status.from': 'restoring',
      'valet.lifecycle.trigger': 'restore_failed',
      'valet.recovery.attempt': 2,
    });
  });
});

describe('stopTraceTrigger', () => {
  it.each([
    ['completed', 'completed'],
    ['sandbox_exited', 'sandbox_exited'],
    ['snapshot_failed', 'snapshot_failed'],
    ['recovery_exhausted', 'recovery_exhausted'],
    ['parent_stopped', 'manual_stop'],
  ])('maps %s to the safe %s trigger', (reason, expected) => {
    expect(stopTraceTrigger(reason)).toBe(expected);
  });
});
