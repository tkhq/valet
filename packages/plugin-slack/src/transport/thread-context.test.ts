import { describe, expect, it, vi } from "vitest";
import { fetchThreadTranscript, type ThreadContextApi } from "./thread-context.js";

function fakeApi(
  messages: Record<string, unknown>[],
  users: Record<string, string> = {},
  opts: { repliesThrows?: boolean } = {},
): ThreadContextApi {
  return {
    conversationsReplies: vi.fn(async () => {
      if (opts.repliesThrows) throw new Error("thread_not_found");
      return messages;
    }),
    usersInfo: vi.fn(async (id: string) =>
      users[id] ? { id, displayName: users[id] } : null,
    ),
  };
}

describe("fetchThreadTranscript", () => {
  it("formats each message as `Name: text`, oldest first, with resolved names", async () => {
    const api = fakeApi(
      [
        { user: "U1", text: "Marketing wants an automation" },
        { user: "U2", text: "this smells like a skill" },
        { user: "U1", text: "<@UBOT> can you file an issue" },
      ],
      { U1: "Brian Brown", U2: "Conner Swann" },
    );
    const out = await fetchThreadTranscript(api, { channelId: "C1", threadTs: "1.0", selfUserId: "UBOT" });
    expect(out).toBe(
      "Brian Brown: Marketing wants an automation\n" +
        "Conner Swann: this smells like a skill\n" +
        "Brian Brown: can you file an issue",
    );
  });

  it("falls back to @id when a user cannot be resolved, and labels bots", async () => {
    const api = fakeApi([
      { user: "U9", text: "hi" },
      { username: "Deploybot", text: "shipped" },
    ]);
    const out = await fetchThreadTranscript(api, { channelId: "C1", threadTs: "1.0" });
    expect(out).toBe("@U9: hi\nDeploybot: shipped");
  });

  it("drops messages with no words (joins, file-only) and returns null when nothing remains", async () => {
    const api = fakeApi([{ user: "U1", text: "" }, { user: "U1" }]);
    expect(await fetchThreadTranscript(api, { channelId: "C1", threadTs: "1.0" })).toBeNull();
  });

  it("returns null when the thread holds only the trigger message (top-level mention)", async () => {
    const api = fakeApi([{ user: "U1", text: "@UBOT do a thing" }], { U1: "Brian" });
    expect(await fetchThreadTranscript(api, { channelId: "C1", threadTs: "1.0", selfUserId: "UBOT" })).toBeNull();
  });

  it("returns null for an empty or unreadable thread", async () => {
    expect(await fetchThreadTranscript(fakeApi([]), { channelId: "C1", threadTs: "1.0" })).toBeNull();
    expect(
      await fetchThreadTranscript(fakeApi([], {}, { repliesThrows: true }), { channelId: "C1", threadTs: "1.0" }),
    ).toBeNull();
  });

  it("drops the oldest lines and notes the omission when the thread is long", async () => {
    const long = "x".repeat(500);
    const messages = Array.from({ length: 20 }, (_, i) => ({ user: "U1", text: `${i}-${long}` }));
    const api = fakeApi(messages, { U1: "Brian" });
    const out = await fetchThreadTranscript(api, { channelId: "C1", threadTs: "1.0" });
    expect(out).toMatch(/^\[\d+ earlier message\(s\) omitted\]\n/);
    expect(out).toContain("Brian: 19-"); // newest kept
    expect(out).not.toContain("Brian: 0-"); // oldest dropped
  });
});
