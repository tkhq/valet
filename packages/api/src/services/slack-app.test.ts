/**
 * The Slack app contract: manifest shape, Slack's own length limits, and
 * the scope helpers the connect route depends on. Pure functions, so these
 * are unit tests with no server.
 */
import { describe, expect, it } from "vitest";
import {
  SLACK_BOT_EVENTS,
  SLACK_OPTIONAL_BOT_SCOPES,
  SLACK_REQUIRED_BOT_SCOPES,
  SLACK_WEBHOOK_MOUNT,
  SLACK_WEBHOOK_PATH,
  buildSlackAppManifest,
  missingScopes,
  parseGrantedScopes,
  slackRequestUrl,
} from "./slack-app.js";
import { SLACK_USER_SCOPES } from "@valet/plugin-slack-user/oauth";

describe("slack bot events", () => {
  it("subscribes the agent messaging experience, not the legacy assistant one", () => {
    expect(SLACK_BOT_EVENTS).toContain("app_home_opened");
    expect(SLACK_BOT_EVENTS).toContain("app_context_changed");
    expect(SLACK_BOT_EVENTS).toContain("message.im");
    expect(SLACK_BOT_EVENTS).not.toContain("assistant_thread_started");
    expect(SLACK_BOT_EVENTS).not.toContain("assistant_thread_context_changed");
  });
});

describe("slack bot scopes", () => {
  /**
   * Every Slack Web API method the transport calls, and the scope it needs.
   * A method whose scope is absent from the manifest fails at runtime with
   * `missing_scope`, weeks after the operator installed the app, so the two
   * lists are pinned here rather than left to review.
   *
   * Sources: the method reference pages under
   * https://docs.slack.dev/reference/methods/.
   */
  const SCOPE_FOR_METHOD: Record<string, string> = {
    "auth.test": "chat:write", // no scope of its own; any token works
    "chat.postMessage": "chat:write",
    "chat.update": "chat:write",
    "chat.startStream": "chat:write",
    "chat.appendStream": "chat:write",
    "chat.stopStream": "chat:write",
    "assistant.threads.setStatus": "assistant:write",
    "assistant.threads.setSuggestedPrompts": "assistant:write",
    "assistant.threads.setTitle": "assistant:write",
    "conversations.open": "im:write",
    "users.list": "users:read",
    "files.info": "files:read",
    "files.getUploadURLExternal": "files:write",
    "files.completeUploadExternal": "files:write",
  };

  it("declares a scope for every Slack method the transport calls", () => {
    const declared = new Set([...SLACK_REQUIRED_BOT_SCOPES, ...SLACK_OPTIONAL_BOT_SCOPES]);
    for (const [method, scope] of Object.entries(SCOPE_FOR_METHOD)) {
      expect(declared, `${method} needs ${scope}`).toContain(scope);
    }
  });

  it("requires the scopes without which the agent cannot hold a conversation", () => {
    // `assistant:write` is also the proof that the agent feature is enabled:
    // Slack adds it when the feature is turned on in app settings.
    expect([...SLACK_REQUIRED_BOT_SCOPES]).toEqual(["assistant:write", "chat:write", "im:history"]);
  });
});

describe("buildSlackAppManifest", () => {
  it("declares agent_view with a writable messages tab", () => {
    const manifest = buildSlackAppManifest({ publicUrl: "https://valet.example.com" });

    expect(manifest.features.agent_view.agent_description.length).toBeGreaterThan(0);
    expect(manifest.features.app_home.messages_tab_enabled).toBe(true);
    // True here disables the composer and the integration is unusable with
    // no error anywhere.
    expect(manifest.features.app_home.messages_tab_read_only_enabled).toBe(false);
    expect(manifest.features.app_home.home_tab_enabled).toBe(false);
    // The deprecated key must not appear under any name.
    expect(JSON.stringify(manifest)).not.toContain("assistant_view");
    expect(JSON.stringify(manifest)).not.toContain("assistant_description");
  });

  it("requests every required and optional scope, and subscribes every declared event", () => {
    const manifest = buildSlackAppManifest({ publicUrl: "https://valet.example.com" });

    for (const scope of [...SLACK_REQUIRED_BOT_SCOPES, ...SLACK_OPTIONAL_BOT_SCOPES]) {
      expect(manifest.oauth_config.scopes.bot).toContain(scope);
    }
    expect(manifest.settings.event_subscriptions.bot_events).toEqual([...SLACK_BOT_EVENTS]);
  });

  it("declares the Slack (personal) user scope bundle and the OAuth callback", () => {
    const manifest = buildSlackAppManifest({ publicUrl: "https://valet.example.com" });

    // Slack grants a user token only the scopes declared in the manifest.
    // A drift between the plugin's bundle and the manifest fails every
    // personal connect with a scope-shortfall error.
    expect([...manifest.oauth_config.scopes.user].sort()).toEqual([...SLACK_USER_SCOPES].sort());
    expect(manifest.oauth_config.redirect_urls).toEqual([
      "https://valet.example.com/api/credentials/oauth/callback",
    ]);
  });

  it("omits redirect_urls without a public URL but keeps the user scopes", () => {
    const manifest = buildSlackAppManifest({ publicUrl: null });

    expect(manifest.oauth_config.redirect_urls).toBeUndefined();
    expect(manifest.oauth_config.scopes.user.length).toBeGreaterThan(0);
  });

  it("points events and interactivity at the path app.ts actually mounts", () => {
    const manifest = buildSlackAppManifest({ publicUrl: "https://valet.example.com" });
    const expected = `https://valet.example.com${SLACK_WEBHOOK_MOUNT}${SLACK_WEBHOOK_PATH}`;

    expect(manifest.settings.event_subscriptions.request_url).toBe(expected);
    expect(manifest.settings.interactivity.request_url).toBe(expected);
    expect(manifest.settings.interactivity.is_enabled).toBe(true);
    expect(manifest.settings.socket_mode_enabled).toBe(false);
  });

  it("selects socket mode and omits both request URLs when no public URL exists", () => {
    const manifest = buildSlackAppManifest({ publicUrl: null });

    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.settings.event_subscriptions.request_url).toBeUndefined();
    expect(manifest.settings.interactivity.request_url).toBeUndefined();
    // Approval gates are Block Kit buttons; Socket Mode carries them too.
    expect(manifest.settings.interactivity.is_enabled).toBe(true);
  });

  it("strips a trailing slash from the public URL", () => {
    const manifest = buildSlackAppManifest({ publicUrl: "https://valet.example.com/" });
    expect(manifest.settings.event_subscriptions.request_url).toBe(
      `https://valet.example.com${SLACK_WEBHOOK_MOUNT}${SLACK_WEBHOOK_PATH}`,
    );
  });

  it("stays inside Slack's length limits, including for an over-long app name", () => {
    const manifest = buildSlackAppManifest({ appName: "V".repeat(80), publicUrl: null });

    expect(manifest.display_information.name.length).toBe(35);
    expect(manifest.features.bot_user.display_name.length).toBe(35);
    expect(manifest.display_information.description?.length ?? 0).toBeLessThanOrEqual(140);
    expect(manifest.features.agent_view.agent_description.length).toBeLessThanOrEqual(300);
  });

  it("names the bot user the same as the app", () => {
    const manifest = buildSlackAppManifest({ appName: "Valet Dev", publicUrl: null });
    expect(manifest.display_information.name).toBe("Valet Dev");
    expect(manifest.features.bot_user.display_name).toBe("Valet Dev");
  });
});

describe("slackRequestUrl", () => {
  it("is null in socket mode", () => {
    expect(slackRequestUrl(null)).toBeNull();
  });
});

describe("parseGrantedScopes", () => {
  it("splits the comma-separated header and trims each scope", () => {
    expect(parseGrantedScopes("assistant:write, chat:write ,im:history")).toEqual([
      "assistant:write",
      "chat:write",
      "im:history",
    ]);
  });

  it("returns null for an absent or blank header, which means unknown, not empty", () => {
    expect(parseGrantedScopes(null)).toBeNull();
    expect(parseGrantedScopes(undefined)).toBeNull();
    expect(parseGrantedScopes("   ")).toBeNull();
  });
});

describe("missingScopes", () => {
  it("reports the required scopes the token does not carry", () => {
    expect(missingScopes(["chat:write"], SLACK_REQUIRED_BOT_SCOPES)).toEqual(["assistant:write", "im:history"]);
  });

  it("reports nothing when every required scope is granted", () => {
    expect(missingScopes([...SLACK_REQUIRED_BOT_SCOPES, "extra:scope"], SLACK_REQUIRED_BOT_SCOPES)).toEqual([]);
  });
});
