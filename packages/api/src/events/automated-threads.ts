/**
 * A thread only automated deliveries write to: the owner's "events" firehose
 * (`EVENTS_THREAD_KEY` in `orchestrator-target.ts`) or a Slack channel's
 * bot-event thread (`slackEventsThreadKey`). No person waits on a turn there
 * that a person did not type, including a delegated task's follow-up, so the
 * host marks those turns unattended (`unattendedThread` in `engine/host.ts`).
 * This module imports nothing, so the host can load it without a cycle.
 */
export function isAutomatedDeliveryThread(thread: { key: string }): boolean {
  return thread.key === "events" || /^slack-events:[^:]+$/.test(thread.key);
}
