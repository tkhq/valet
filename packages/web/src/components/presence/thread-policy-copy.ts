/**
 * Copy and defaults for a rule's thread policy, the **Runs in** control
 * (docs/specs/2026-10-16-presence-hub-design.md Part C steps 2 and 3, and
 * docs/specs/2026-10-16-delivery-threads-and-claims-design.md Part A).
 * Pure, so the rules are tested without a render.
 */
import type { AssistantThreadPolicy } from "@valet/shared";

/** The grouping unit a rule's events name, in UI words. */
export type SubjectKind = "channel" | "pull request" | "issue" | "repository";

/** Which rule the policy belongs to: an event listener or a schedule. */
export type RuleKind = "listener" | "routine";

/** The automation wizard's outcomes, as far as the default policy cares. */
export type WizardOutcome = "reply" | "workflow" | "notify" | "advanced" | "schedule" | "thread";

const GITHUB_PULL_REQUEST = /(^|[._])(pr|pull|pull_request|review|check|check_run|check_suite|status)([._]|$)/;
const GITHUB_ISSUE = /(^|[._])issues?([._]|$)/;

/**
 * The subject kind for a rule's event keys, or null when no key names a
 * natural subject. The first key whose service has a subject decides: Slack
 * groups by channel, Linear by issue, and GitHub by pull request (when any
 * key names pull requests, reviews, checks, or statuses), then issue, then
 * repository. This mirrors the plugins' `naturalSubject` hooks; the server
 * makes the final check.
 */
export function subjectKindForKeys(keys: readonly string[]): SubjectKind | null {
  for (const key of keys) {
    if (key.startsWith("slack.")) return "channel";
    if (key.startsWith("linear.")) return "issue";
    if (key.startsWith("github.")) {
      const github = keys.filter((k) => k.startsWith("github.")).map((k) => k.slice("github.".length));
      if (github.some((k) => GITHUB_PULL_REQUEST.test(k))) return "pull request";
      if (github.some((k) => GITHUB_ISSUE.test(k))) return "issue";
      return "repository";
    }
  }
  return null;
}

/** The option copy for the subject mode. */
export function subjectOptionLabel(subjectKind: SubjectKind | null): string {
  return `One thread per ${subjectKind ?? "place"}`;
}

/** The rule's own thread, named for its kind. */
export function ownOptionLabel(ruleKind: RuleKind): string {
  return ruleKind === "listener" ? "This listener's thread" : "This routine's thread";
}

/**
 * True when a rule's keys carry Slack conversations: mentions, channel
 * messages, replies, and direct messages. Deliveries of these events have a
 * Slack channel origin.
 */
export function carriesSlackConversation(keys: readonly string[]): boolean {
  return keys.some((k) => k === "slack.app_mention" || k === "slack.message" || k.startsWith("slack.message.") || k === "slack.*");
}

/**
 * The policy a stored subscription runs with. An absent policy reads as
 * `new` when the target follows its conversations or the keys carry Slack
 * conversations, `subject` (one thread per channel) for other Slack keys,
 * else `own`. The api decides per delivery (a delivery with a Slack channel
 * origin gets `new`, another Slack channel event gets `subject`); this is
 * the rule-level approximation for display.
 */
export function displayThreadPolicy(
  target: { thread?: AssistantThreadPolicy | null; follow?: boolean },
  eventKeys: readonly string[],
): AssistantThreadPolicy {
  if (target.thread !== undefined && target.thread !== null) return target.thread;
  if (target.follow === true || carriesSlackConversation(eventKeys)) return { mode: "new" };
  if (eventKeys.some((key) => key.startsWith("slack."))) return { mode: "subject" };
  return { mode: "own" };
}

/** The note under Runs in when one thread would hold several Slack conversations. */
export const SHARED_SLACK_THREAD_NOTE = "Messages from several Slack conversations will share this thread.";

/**
 * The wizard's starting policy: a mention rule replies in a new thread; a
 * notification or a workflow event whose keys name a subject groups by that
 * subject; everything else uses the rule's own thread.
 */
export function defaultWizardThreadPolicy(
  outcome: WizardOutcome,
  subjectKind: SubjectKind | null,
): AssistantThreadPolicy {
  if (outcome === "reply") return { mode: "new" };
  if ((outcome === "notify" || outcome === "workflow") && subjectKind !== null) return { mode: "subject" };
  return { mode: "own" };
}

/** True when two policies send deliveries to the same place. */
export function sameThreadPolicy(a: AssistantThreadPolicy, b: AssistantThreadPolicy): boolean {
  if (a.mode === "existing" && b.mode === "existing") {
    return a.sessionId === b.sessionId && a.threadId === b.threadId;
  }
  return a.mode === b.mode;
}
