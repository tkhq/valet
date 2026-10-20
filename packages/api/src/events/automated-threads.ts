/**
 * The thread a non-channel event delivery lands on: the owner's default
 * assistant "events" firehose. Named so the outbound reply path can recognise
 * it without a magic string (`ChannelHost.deliverAssistantMessage`).
 */
export const EVENTS_THREAD_KEY = "events";

/**
 * A thread only automated deliveries write to. The thread policy lands a
 * delivery on a key it owns: `sub:<rule>` (a rule's own thread),
 * `sub:<rule>:<delivery>` (a new thread per event), `schedule:<rule>` and
 * `schedule:<rule>:<fire>` (a routine's threads), or `subject:<natural
 * subject>` (one thread per pull request, issue, or channel). Rows written
 * before the policy sit on the owner's `events` firehose or a Slack
 * channel's `slack-events:<channel>` thread. No person waits on a turn there
 * that a person did not type, including a delegated task's follow-up, so
 * the host marks those turns unattended (`automatedThread` in
 * `engine/host.ts`). A pinned existing thread keeps its own key and is not
 * one of these. A task such a turn delegates can still ask in the inbox.
 * This module imports nothing, so the host can load it without a cycle.
 */
const POLICY_THREAD_KEY = /^(sub|schedule|subject):/;

export function isAutomatedDeliveryThread(thread: { key: string }): boolean {
  return thread.key === EVENTS_THREAD_KEY || /^slack-events:[^:]+$/.test(thread.key) || POLICY_THREAD_KEY.test(thread.key);
}
