/**
 * A person's edit of a Slack message that already reached a Valet thread
 * (docs/specs/2026-10-22-thread-edit-fork-design.md, "Slack edits"). Valet
 * cannot rewrite the thread for a Slack edit, because the Slack copy of the
 * reply stays. It records the change for the model, with no reply, so the
 * next turn uses the new wording.
 */
import type { SignalContent } from "@valet/engine";

/** The longest text one side of an edit note carries. */
const MAX_EDIT_SIDE_CHARS = 4_000;

function cut(text: string): string {
  return text.length > MAX_EDIT_SIDE_CHARS ? `${text.slice(0, MAX_EDIT_SIDE_CHARS)}…` : text;
}

/** The record-only signal for one Slack edit. */
export function slackEditSignal(args: {
  previousText: string;
  text: string;
  attributes?: Record<string, string>;
  origin?: SignalContent["origin"];
}): SignalContent {
  return {
    kind: "signal",
    signalType: "slack.message_changed",
    tagName: "slack-edit",
    body: [
      "The person edited an earlier message in Slack. They sent no new message, so do not reply to the edit itself. Use the new wording from now on.",
      `Before: ${cut(args.previousText)}`,
      `After: ${cut(args.text)}`,
    ].join("\n"),
    ...(args.attributes ? { attributes: args.attributes } : {}),
    ...(args.origin ? { origin: args.origin } : {}),
  };
}
