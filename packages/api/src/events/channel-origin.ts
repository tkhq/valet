/**
 * Builds the `EventDispatcher`'s `resolveChannelOrigin` seam from a transport
 * registry (the `ChannelHost`). A channel event whose transport can derive a
 * thread key gets a `ChannelOrigin`, so the assistant's reply routes back to
 * the conversation. A non-channel event (GitHub, Linear) resolves to `null`.
 */
import type { ChannelOrigin } from "@valet/engine";

interface TransportRegistry {
  transportFor(channelType: string): {
    threadKeyFromEvent?(eventKey: string, payload: unknown): string | null;
  } | null;
}

export function channelOriginResolver(
  registry: TransportRegistry,
): (service: string, eventKey: string, payload: unknown) => ChannelOrigin | null {
  return (service, eventKey, payload) => {
    const threadKey = registry.transportFor(service)?.threadKeyFromEvent?.(eventKey, payload) ?? null;
    return threadKey ? { channelType: service, threadKey } : null;
  };
}
