/**
 * The thread a non-channel event delivery lands on: the owner's default
 * assistant "events" firehose. Named so the outbound reply path can recognise
 * it without a magic string (`ChannelHost.deliverAssistantMessage`).
 */
export const EVENTS_THREAD_KEY = "events";

/**
 * A thread only automated deliveries write to: the owner's "events" firehose
 * or a Slack channel's bot-event thread (`slackEventsThreadKey`). No person
 * waits on a turn there that a person did not type, including a delegated
 * task's follow-up, so the host marks those turns unattended
 * (`automatedThread` in `engine/host.ts`). A task such a turn delegates can
 * still ask in the inbox. This module imports nothing, so the host can load
 * it without a cycle.
 */
export function isAutomatedDeliveryThread(thread: { key: string }): boolean {
  return thread.key === EVENTS_THREAD_KEY || /^slack-events:[^:]+$/.test(thread.key);
}
