import { describe, expect, it } from "vitest";
import { readAppPageHint, renderAppPageHint } from "../src/app-page-hint.js";
import { entriesToAgentMessages, renderReplyContext } from "../src/thread.js";
import type { MessageEntry } from "../src/types.js";

describe("Ask Valet page hints", () => {
  it("accepts a bounded page path and workspace without making either an authorization grant", () => {
    const hint = { pathname: "/settings/teams/team_b", workspace: "team_a" };
    expect(readAppPageHint(hint)).toEqual(hint);
    const text = renderAppPageHint("Change its model.", hint);
    expect(text).toContain("team_b");
    expect(text).toContain("Settings scope: team team_b");
    expect(text).toContain("not authorization");
    expect(text).toContain("For this message only");
  });
  it.each([
    { pathname: "https://example.com/settings", workspace: "user" },
    { pathname: "/settings?token=secret", workspace: "user" },
    { pathname: "/settings#secret", workspace: "user" },
    { pathname: "/arbitrary-secret", workspace: "user" },
    { pathname: "/settings/teams/%3Csecret%3E", workspace: "user" },
    { pathname: "/settings", workspace: "a".repeat(129) },
  ])("omits unsafe hints %j", hint => {
    expect(readAppPageHint(hint)).toBeUndefined();
    expect(renderAppPageHint("Help.", hint)).toBe("Help.");
  });
  it("uses each submission's page without retaining an earlier current page", () => {
    expect(renderAppPageHint("First", { pathname: "/settings/profile", workspace: "user" })).toContain("/settings/profile");
    expect(renderAppPageHint("Second", { pathname: "/integrations", workspace: "user" })).not.toContain("/settings/profile");
    expect(renderAppPageHint("Third", undefined)).toBe("Third");
  });

  it("renders the same bounded hint for a live prompt and restored history while keeping saved user text clean", () => {
    const entry: MessageEntry = { id: "one", sessionId: "s", threadId: "t", parentId: null, createdAt: 1,
      type: "message", role: "user", content: "Help here.", metadata: { appPageHint: { pathname: "/settings/profile", workspace: "user" } } };
    const live = renderReplyContext(entry.content, entry.metadata);
    expect(live).toContain("/settings/profile");
    const restored = entriesToAgentMessages([entry], { api: "anthropic", provider: "anthropic", id: "model" });
    expect(restored).toEqual([{ role: "user", timestamp: 1, content: [{ type: "text", text: `[sent: Thursday 1970-01-01 00:00 UTC]\n\n${live}` }] }]);
    expect(entry.content).toBe("Help here.");
  });
});
