/** Slack's Copy link format. A reply link carries its parent's timestamp. */
export function parseSlackThreadLink(value: string): { channel: string; threadTs: string } | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || !url.hostname.endsWith(".slack.com")) return null;
    const match = /^\/archives\/([CDG][A-Z0-9]+)\/p(\d{16})\/?$/.exec(url.pathname);
    if (!match) return null;
    const parent = url.searchParams.get("thread_ts");
    if (parent !== null && !/^\d{10}\.\d{6}$/.test(parent)) return null;
    return { channel: match[1], threadTs: parent ?? `${match[2].slice(0, -6)}.${match[2].slice(-6)}` };
  } catch { return null; }
}

/**
 * The filter rows that follow one Slack thread: its channel and its parent
 * timestamp. The wizard's create and its preview both read these rows.
 */
export function slackThreadFilterRows(preset: { channel: string; threadTs: string }): Array<{
  id: string;
  field: string;
  op: "eq";
  value: string;
}> {
  return [
    { id: "thread-channel", field: "channel", op: "eq", value: preset.channel },
    { id: "thread-timestamp", field: "thread_ts", op: "eq", value: preset.threadTs },
  ];
}
