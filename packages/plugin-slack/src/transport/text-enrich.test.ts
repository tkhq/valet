import { describe, expect, it, vi } from "vitest";
import { enrichSlackText, type EnrichApi } from "./text-enrich.js";

function api(users: Record<string, string> = {}): EnrichApi {
  return {
    usersInfo: vi.fn(async (id: string) => (users[id] ? { id, displayName: users[id] } : null)),
  };
}

describe("enrichSlackText", () => {
  it("resolves other users' mentions to names, including the labeled form", async () => {
    const out = await enrichSlackText(api({ U1: "Brian Brown", U2: "Conner" }), "hey <@U1> and <@U2|conner> look");
    expect(out).toBe("hey @Brian Brown and @Conner look");
  });

  it("strips the bot's own mention and never resolves it", async () => {
    const a = api({ UBOT: "Valet" });
    const out = await enrichSlackText(a, "<@UBOT> file an issue", "UBOT");
    expect(out).toBe("file an issue");
    expect(a.usersInfo).not.toHaveBeenCalledWith("UBOT");
  });

  it("falls back to @id when a mentioned user cannot be resolved", async () => {
    expect(await enrichSlackText(api(), "ping <@U9>")).toBe("ping @U9");
  });

  it("collapses channel links (labeled and bare) and url markup", async () => {
    const out = await enrichSlackText(api(), "see <#C1|general> and <#C2> at <https://x.io|the doc> <https://y.io>");
    expect(out).toBe("see #general and #C2 at the doc https://y.io");
  });
});
