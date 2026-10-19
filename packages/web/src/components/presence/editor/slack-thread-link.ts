/**
 * A pasted Slack message link, read as the thread to follow
 * (docs/specs/2026-10-16-presence-hub-design.md Part H step 3). The
 * editor's When for Slack offers `A reply in one Slack thread`; the link
 * becomes the `channel` and `thread_ts` conditions on `slack.message`.
 */
import type { UiFilterRow } from "~/components/events/filter-editor";

/** The thread a link names: its channel and its parent timestamp. */
export interface SlackThread {
  channel: string;
  threadTs: string;
}

/** Slack's Copy link format. A reply link carries its parent's timestamp. */
export function parseSlackThreadLink(value: string): SlackThread | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || !url.hostname.endsWith(".slack.com")) return null;
    const match = /^\/archives\/([CDG][A-Z0-9]+)\/p(\d{16})\/?$/.exec(url.pathname);
    if (!match) return null;
    const parent = url.searchParams.get("thread_ts");
    if (parent !== null && !/^\d{10}\.\d{6}$/.test(parent)) return null;
    const [, channel, ts] = match;
    if (channel === undefined || ts === undefined) return null;
    return { channel, threadTs: parent ?? `${ts.slice(0, -6)}.${ts.slice(-6)}` };
  } catch {
    return null;
  }
}

/** The ids of the two condition rows a thread makes, so a new link replaces them. */
export const THREAD_CHANNEL_ROW = "thread-channel";
export const THREAD_TIMESTAMP_ROW = "thread-timestamp";

/** The conditions that follow one Slack thread: its channel and its parent timestamp. */
export function slackThreadFilterRows(thread: SlackThread): UiFilterRow[] {
  return [
    { id: THREAD_CHANNEL_ROW, field: "channel", op: "eq", value: thread.channel },
    { id: THREAD_TIMESTAMP_ROW, field: "thread_ts", op: "eq", value: thread.threadTs },
  ];
}

/** The error under a link that does not parse. */
export const BAD_THREAD_LINK = "That is not a Slack message link. Copy the link from the message's menu.";
