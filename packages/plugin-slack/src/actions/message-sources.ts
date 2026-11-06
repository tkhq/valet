import type { SourceInput } from '@valet/shared';
import { slackGet } from './api.js';

/**
 * Sources for messages that Slack history and thread reads return. Those
 * calls give no permalinks, and chat.getPermalink costs one call for each
 * message. Slack documents the link shape instead: the workspace URL, the
 * channel id, and the timestamp without its dot. The workspace URL comes
 * from one auth.test call.
 */

/** The workspace base URL ("https://acme.slack.com"), or undefined when Slack does not say. */
export async function slackWorkspaceUrl(token: string, signal?: AbortSignal, get: typeof slackGet = slackGet): Promise<string | undefined> {
  try {
    const res = await get('auth.test', token, {}, undefined, signal);
    if (!res.ok) return undefined;
    const data = (await res.json()) as { ok?: boolean; url?: string };
    const url = data.ok && typeof data.url === 'string' ? data.url.replace(/\/+$/, '') : undefined;
    return url && /^https:\/\//.test(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

/** The permalink Slack shows for a message. A reply carries its thread so the link opens the thread. */
export function messagePermalink(base: string, channel: string, ts: string, threadTs?: string): string | undefined {
  if (!/^\d+\.\d+$/.test(ts) || !/^[A-Z0-9]+$/.test(channel)) return undefined;
  const link = `${base}/archives/${channel}/p${ts.replace('.', '')}`;
  return threadTs && threadTs !== ts && /^\d+\.\d+$/.test(threadTs) ? `${link}?thread_ts=${threadTs}&cid=${channel}` : link;
}

function when(ts: string): string | undefined {
  const seconds = Number(ts);
  return Number.isFinite(seconds) ? `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` : undefined;
}

/** How a reader names the place: the channel name when known, else "Slack message". */
function place(channelName: string | undefined, channel: string, kind: 'message' | 'reply'): string {
  if (channelName) return `${kind === 'reply' ? 'Reply' : 'Message'} in #${channelName}`;
  if (channel.startsWith('D')) return kind === 'reply' ? 'Direct message reply' : 'Direct message';
  return kind === 'reply' ? 'Slack reply' : 'Slack message';
}

/** One source for each message with text, newest first as Slack returns them, up to `limit`. */
export function messageSources(opts: {
  base: string;
  channel: string;
  channelName?: string;
  messages: ReadonlyArray<Record<string, unknown>>;
  limit?: number;
}): SourceInput[] {
  const sources: SourceInput[] = [];
  for (const message of opts.messages) {
    if (sources.length >= (opts.limit ?? 20)) break;
    const ts = message.ts;
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (typeof ts !== 'string' || !text) continue;
    const threadTs = typeof message.thread_ts === 'string' ? message.thread_ts : undefined;
    const url = messagePermalink(opts.base, opts.channel, ts, threadTs);
    if (!url) continue;
    const location = when(ts);
    sources.push({
      service: 'slack',
      title: place(opts.channelName, opts.channel, threadTs && threadTs !== ts ? 'reply' : 'message'),
      url,
      snippet: text,
      ...(location ? { location } : {}),
    });
  }
  return sources;
}
