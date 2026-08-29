import { describe, expect, it } from "vitest";
import { channelMessageNormalizer, channelOriginResolver } from "./channel-origin.js";

/** A registry whose one transport exposes just the seams these resolvers use. */
function registry(transport: Record<string, unknown> | null) {
  return { transportFor: (service: string) => (service === "slack" ? transport : null) } as never;
}

describe("channelOriginResolver", () => {
  it("stamps the thread key, the triggering message ts, and the addressed reply mode", () => {
    const resolve = channelOriginResolver(
      registry({
        threadKeyFromEvent: () => "slack:C1:1.2",
        messageTsFromEvent: () => "1.7",
      }),
    );
    expect(resolve("slack", "slack.app_mention", {})).toEqual({
      channelType: "slack",
      threadKey: "slack:C1:1.2",
      reply: "auto",
      messageTs: "1.7",
    });
  });

  it("omits messageTs when the transport cannot supply one", () => {
    const resolve = channelOriginResolver(registry({ threadKeyFromEvent: () => "slack:C1:1.2" }));
    expect(resolve("slack", "slack.app_mention", {})).toEqual({
      channelType: "slack",
      threadKey: "slack:C1:1.2",
      reply: "auto",
    });
  });

  it("returns null for a non-channel event or unknown service", () => {
    const resolve = channelOriginResolver(registry({ threadKeyFromEvent: () => null }));
    expect(resolve("slack", "slack.team_join", {})).toBeNull();
    expect(resolve("github", "issues.opened", {})).toBeNull();
  });
});

describe("channelMessageNormalizer", () => {
  it("delegates to the transport", async () => {
    const normalize = channelMessageNormalizer(
      registry({ normalizeForAgent: async () => ({ senderName: "Brian", text: "clean" }) }),
    );
    expect(await normalize("slack", { userId: "U1", text: "raw" })).toEqual({ senderName: "Brian", text: "clean" });
  });

  it("falls back to the raw text when no transport or method is available", async () => {
    expect(await channelMessageNormalizer(registry(null))("slack", { text: "raw" })).toEqual({ text: "raw" });
    expect(await channelMessageNormalizer(registry({}))("slack", { text: "raw" })).toEqual({ text: "raw" });
  });
});
