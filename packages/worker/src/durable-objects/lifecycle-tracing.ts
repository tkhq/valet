import type { Attributes } from '@opentelemetry/api';
import type { SessionLifecycleStatus } from './session-state.js';

export type LifecycleTraceTrigger =
  | 'initial_start'
  | 'manual_stop'
  | 'completed'
  | 'sandbox_exited'
  | 'recovery_exhausted'
  | 'manual_hibernate'
  | 'idle_timeout'
  | 'manual_wake'
  | 'auto_wake'
  | 'runner_disconnect'
  | 'backoff_retry'
  | 'watchdog_timeout'
  | 'ensure_running'
  | 'refresh'
  | 'snapshot_failed'
  | 'restore_failed'
  | 'spawn_failed';

export type LifecycleTraceErrorClass =
  | 'backend_failure'
  | 'backend_http'
  | 'backend_network'
  | 'configuration_missing'
  | 'recovery_exhausted'
  | 'sandbox_exited'
  | 'snapshot_failed';

export function recoveryTraceTrigger(reason: string): LifecycleTraceTrigger {
  if (reason === 'sandbox_lost') return 'runner_disconnect';
  if (reason === 'backoff_retry') return 'backoff_retry';
  if (reason === 'ensure_running' || reason === 'ensure_running_after_backoff') return 'ensure_running';
  if (reason === 'refresh') return 'refresh';
  if (reason.startsWith('restore_failed:')) return 'restore_failed';
  if (reason.startsWith('spawn_failed:')) return 'spawn_failed';
  return 'watchdog_timeout';
}

export function stopTraceTrigger(reason: string): LifecycleTraceTrigger {
  if (reason === 'completed') return 'completed';
  if (reason === 'sandbox_exited') return 'sandbox_exited';
  if (reason === 'snapshot_failed') return 'snapshot_failed';
  if (reason === 'recovery_exhausted') return 'recovery_exhausted';
  return 'manual_stop';
}

export function lifecycleTaskAttributes(input: {
  sessionId: string;
  userId: string;
  statusFrom: SessionLifecycleStatus;
  trigger: LifecycleTraceTrigger;
  recoveryAttempt?: number;
}): Attributes {
  return {
    'valet.session.id': input.sessionId,
    'valet.user.id': input.userId,
    'valet.session.status.from': input.statusFrom,
    'valet.lifecycle.trigger': input.trigger,
    ...(input.recoveryAttempt !== undefined ? { 'valet.recovery.attempt': input.recoveryAttempt } : {}),
  };
}
