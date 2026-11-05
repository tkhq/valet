import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VerifiedEvent } from "@valet/engine";
import { clearChannelNameCache } from "./actions/channel-names.js";
import { withEventChannelName } from "./event-channel-name.js";

const TOKEN = "xoxb-test-token";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function message(payload: Record<string, unknown>, eventType = "message"): VerifiedEvent {
  return { eventType, deliveryId: "Ev-1", payload: { type: "message", ts: "1700.5", ...payload } };
}

function nameOf(event: VerifiedEvent): unknown {
  return (event.payload as Record<string, unknown>).channel_name;
}

describe("withEventChannelName", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearChannelNameCache();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["message", "bot_message", "app_mention"])("adds the channel name to a %s payload", async (eventType) => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, channel: { id: "C1", name: "alerts-prod" } }));

    const named = await withEventChannelName(message({ channel: "C1", channel_type: "channel" }, eventType), TOKEN);

    expect(nameOf(named)).toBe("alerts-prod");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("conversations.info?channel=C1");
  });

  it("keeps a name the payload already carries and sends no request", async () => {
    const event = message({ channel: "C1", channel_name: "alerts-prod" });

    expect(await withEventChannelName(event, TOKEN)).toBe(event);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not look up a direct message, which has no name", async () => {
    const event = message({ channel: "D1", channel_type: "im" });

    expect(await withEventChannelName(event, TOKEN)).toBe(event);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves the payload without a name when the lookup fails", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: "missing_scope" }));
    const event = message({ channel: "C1" });

    expect(nameOf(await withEventChannelName(event, TOKEN))).toBeUndefined();
  });

  it("does nothing without a Slack token", async () => {
    const event = message({ channel: "C1" });

    expect(await withEventChannelName(event, undefined)).toBe(event);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the new name at once after a channel_rename event", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, channel: { id: "C1", name: "alerts-prod" } }));
    expect(nameOf(await withEventChannelName(message({ channel: "C1" }), TOKEN))).toBe("alerts-prod");

    await withEventChannelName({
      eventType: "channel_rename",
      deliveryId: "Ev-rename",
      payload: { type: "channel_rename", channel: { id: "C1", name: "archive-prod", created: 1700 } },
    }, TOKEN);

    expect(nameOf(await withEventChannelName(message({ channel: "C1" }), TOKEN))).toBe("archive-prod");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("records the name of a created channel", async () => {
    await withEventChannelName({
      eventType: "channel_created",
      deliveryId: "Ev-created",
      payload: { type: "channel_created", channel: { id: "C2", name: "alerts-eu", creator: "U1" } },
    }, TOKEN);

    expect(nameOf(await withEventChannelName(message({ channel: "C2" }), TOKEN))).toBe("alerts-eu");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves an event type with no channel_name filter unchanged", async () => {
    const event: VerifiedEvent = {
      eventType: "reaction_added",
      deliveryId: "Ev-r",
      payload: { type: "reaction_added", item: { channel: "C1" } },
    };

    expect(await withEventChannelName(event, TOKEN)).toBe(event);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
