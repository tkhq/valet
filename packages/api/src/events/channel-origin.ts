/**
 * Builds the `EventDispatcher`'s channel seams from a transport registry (the
 * `ChannelHost`):
 * - `channelOriginResolver` — a channel event whose transport can derive a
 *   thread key gets a `ChannelOrigin` (thread key + the triggering message ts +
 *   the addressed reply mode), so the assistant's reply routes back to the
 *   conversation and it can react to the message. A non-channel event resolves
 *   to `null`.
 * - `channelMessageNormalizer` — resolves the sender's display name and cleans
 *   the message text, so the agent never sees a raw `U0AJ…` id or `<@U…>` markup.
 */
import type { ChannelOrigin } from "@valet/engine";

interface TransportRegistry {
  transportFor(channelType: string): {
    threadKeyFromEvent?(eventKey: string, payload: unknown): string | null;
    messageTsFromEvent?(eventKey: string, payload: unknown): string | null;
    normalizeForAgent?(msg: { userId?: string; text: string }): Promise<{ senderName?: string; text: string }>;
  } | null;
}

export function channelOriginResolver(
  registry: TransportRegistry,
): (service: string, eventKey: string, payload: unknown) => ChannelOrigin | null {
  return (service, eventKey, payload) => {
    const transport = registry.transportFor(service);
    const threadKey = transport?.threadKeyFromEvent?.(eventKey, payload) ?? null;
    if (!threadKey) return null;
    const messageTs = transport?.messageTsFromEvent?.(eventKey, payload) ?? undefined;
    // A dispatched channel event is an addressed mention, so its reply auto-posts.
    return { channelType: service, threadKey, reply: "auto", ...(messageTs ? { messageTs } : {}) };
  };
}

export function channelMessageNormalizer(
  registry: TransportRegistry,
): (service: string, msg: { userId?: string; text: string }) => Promise<{ senderName?: string; text: string }> {
  return async (service, msg) => {
    const normalized = await registry.transportFor(service)?.normalizeForAgent?.(msg);
    return normalized ?? { text: msg.text };
  };
}
