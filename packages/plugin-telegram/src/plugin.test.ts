import { describe, expect, it } from "vitest";
import { validateValetPlugin } from "@valet/engine";
import plugin from "./plugin.js";

describe("telegram plugin manifest", () => {
  it("passes structural validation", () => {
    const res = validateValetPlugin(plugin);
    expect(res).toEqual({ ok: true, plugin });
  });
  it("declares the telegram transport and bot_token credential", () => {
    expect(plugin.transports?.[0]?.channelType).toBe("telegram");
    expect(plugin.credentials?.[0]).toMatchObject({
      type: "bot_token",
      configKeys: ["accessToken"],
      requires: { orgCredential: true },
    });
    expect(plugin.actions?.[0]?.actions.map((action) => action.id)).toContain("telegram.reply_to_origin");
  });
});
