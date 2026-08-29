/**
 * Builds the delivery path's `fetchThreadContext` seam from a transport registry
 * (the `ChannelHost`), parallel to `channelOriginResolver`. When an assistant is
 * first reached in a channel thread, this fetches the thread's earlier messages
 * so the assistant starts with the whole conversation, not the lone trigger
 * message. A transport without thread history, or a thread key it does not own,
 * resolves to `null` — delivery then seeds nothing.
 */
import type { ChannelOrigin } from "@valet/engine";

interface TransportRegistry {
  transportFor(channelType: string): {
    fetchThreadContext?(channelId: string, threadTs: string): Promise<string | null>;
  } | null;
}

/**
 * Split a `ChannelOrigin.threadKey` (`${channelType}:${channelId}:${threadTs}`)
 * into its channel and thread parts. A Slack `threadTs` carries a dot, never a
 * colon, so the first colon after the channel id ends the channel segment.
 */
function parseOriginThreadKey(
  channelType: string,
  threadKey: string,
): { channelId: string; threadTs: string } | null {
  const prefix = `${channelType}:`;
  if (!threadKey.startsWith(prefix)) return null;
  const rest = threadKey.slice(prefix.length);
  const sep = rest.indexOf(":");
  if (sep <= 0 || sep >= rest.length - 1) return null;
  return { channelId: rest.slice(0, sep), threadTs: rest.slice(sep + 1) };
}

export function channelThreadContextFetcher(
  registry: TransportRegistry,
): (origin: ChannelOrigin) => Promise<string | null> {
  return async (origin) => {
    const transport = registry.transportFor(origin.channelType);
    if (!transport?.fetchThreadContext) return null;
    const parsed = parseOriginThreadKey(origin.channelType, origin.threadKey);
    if (!parsed) return null;
    return transport.fetchThreadContext(parsed.channelId, parsed.threadTs).catch(() => null);
  };
}
