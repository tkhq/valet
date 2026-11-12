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
 *
 * A policy key does not prove that nobody waits. A Slack mention under an
 * absent policy lands on `sub:<rule>:<delivery>`, and the person who
 * mentioned the assistant answers its questions there. An attended delivery
 * marks its thread `CONVERSATIONAL_THREAD_KEY` (`deliverToAssistantThread`),
 * and a marked policy thread is a conversation from then on. The legacy
 * `events` and `slack-events:<channel>` threads never carry a conversation:
 * a mention always had its own Slack thread. They stay automated even if a
 * flagless follow-up marks them.
 * This module imports nothing, so the host can load it without a cycle.
 */
const POLICY_THREAD_KEY = /^(sub|schedule|subject):/;

/** Thread metadata flag: an attended delivery landed here, so a person takes part. */
export const CONVERSATIONAL_THREAD_KEY = "conversational";

/** True for a legacy automated key, `events` or `slack-events:<channel>`. */
function isLegacyAutomatedKey(key: string): boolean {
  return key === EVENTS_THREAD_KEY || /^slack-events:[^:]+$/.test(key);
}

/**
 * True when the automated-thread rule covers `key`: a policy key or a
 * legacy automated key. Only these keys read `CONVERSATIONAL_THREAD_KEY`,
 * so `deliverToAssistantThread` writes the flag on no other thread.
 */
export function isAutomatedThreadKey(key: string): boolean {
  return isLegacyAutomatedKey(key) || POLICY_THREAD_KEY.test(key);
}

export function isAutomatedDeliveryThread(thread: { key: string; metadata?: Record<string, unknown> }): boolean {
  if (isLegacyAutomatedKey(thread.key)) return true;
  return POLICY_THREAD_KEY.test(thread.key) && thread.metadata?.[CONVERSATIONAL_THREAD_KEY] !== true;
}

/**
 * True when an unattended delivery here runs as a fresh-context turn: the
 * model gets the system prompt, the tools, and the delivery, but not the
 * thread's earlier turns. A rule's own thread (`sub:<rule>`,
 * `schedule:<rule>`) and the legacy `events` firehose collect one job per
 * delivery, and a delivery an hour or more after the last one misses the
 * prompt cache, so carrying the history re-wrote it at the cache-write rate
 * every time. The entries still join the thread. A thread a person joined
 * (`CONVERSATIONAL_THREAD_KEY`) keeps its history, and so does a subject
 * thread or a Slack channel thread, whose earlier turns are about the same
 * pull request, issue, or conversation.
 */
export function deliveryRunsWithoutHistory(thread: { key: string; metadata?: Record<string, unknown> }): boolean {
  if (thread.key === EVENTS_THREAD_KEY) return true;
  return /^(sub|schedule):/.test(thread.key) && thread.metadata?.[CONVERSATIONAL_THREAD_KEY] !== true;
}
