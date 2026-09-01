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

  it("windowed: keeps only messages strictly between afterTs and beforeTs, minus the bot's own", async () => {
    const api = fakeApi(
      [
        { user: "U1", text: "the mention", ts: "1.0" },
        { user: "UBOT", text: "my reply", ts: "1.5" },
        { user: "U2", text: "missed while down", ts: "2.0" },
        { username: "Deploybot", text: "shipped v2", ts: "2.5" },
        { user: "U1", text: "the new message", ts: "3.0" },
      ],
      { U1: "Brian", U2: "Conner" },
    );
    const out = await fetchThreadTranscript(api, {
      channelId: "C1",
      threadTs: "1.0",
      selfUserId: "UBOT",
      afterTs: "1.0",
      beforeTs: "3.0",
    });
    expect(out).toBe("Conner: missed while down\nDeploybot: shipped v2");
  });

  it("windowed: returns null when nothing falls inside the window", async () => {
    const api = fakeApi([
      { user: "U1", text: "old", ts: "1.0" },
      { user: "U1", text: "current", ts: "2.0" },
    ]);
    expect(
      await fetchThreadTranscript(api, { channelId: "C1", threadTs: "1.0", afterTs: "1.0", beforeTs: "2.0" }),
    ).toBeNull();
  });

  it("windowed: compares ts numerically, not lexicographically", async () => {
    // "10.0" < "9.0" as strings; numerically it is inside (9, 11).
    const api = fakeApi([{ user: "U1", text: "in window", ts: "10.0" }], { U1: "Brian" });
    expect(
      await fetchThreadTranscript(api, { channelId: "C1", threadTs: "1.0", afterTs: "9.0", beforeTs: "11.0" }),
    ).toBe("Brian: in window");
  });

  it("returns null for an empty or unreadable thread", async () => {
    expect(await fetchThreadTranscript(fakeApi([]), { channelId: "C1", threadTs: "1.0" })).toBeNull();
    expect(
      await fetchThreadTranscript(fakeApi([], {}, { repliesThrows: true }), { channelId: "C1", threadTs: "1.0" }),
    ).toBeNull();
  });

  it("keeps the thread root and the newest tail, dropping the middle when long", async () => {
    const long = "x".repeat(500);
    const messages = Array.from({ length: 20 }, (_, i) => ({ user: "U1", text: `${i}-${long}` }));
    const api = fakeApi(messages, { U1: "Brian" });
    const out = await fetchThreadTranscript(api, { channelId: "C1", threadTs: "1.0" });
    expect(out).toMatch(/^Brian: 0-/); // the opening message (topic) is preserved
    expect(out).toContain("[");
    expect(out).toMatch(/\[\d+ earlier message\(s\) omitted\]/); // the middle is dropped
    expect(out).toContain("Brian: 19-"); // newest kept
    expect(out).not.toContain("Brian: 5-"); // a middle message dropped
  });

  it("resolves in-text @mentions of other users to names", async () => {
    const api = fakeApi(
      [
        { user: "U1", text: "assigning to <@U2>" },
        { user: "U2", text: "on it" },
      ],
      { U1: "Brian", U2: "Conner Swann" },
    );
    const out = await fetchThreadTranscript(api, { channelId: "C1", threadTs: "1.0" });
    expect(out).toBe("Brian: assigning to @Conner Swann\nConner Swann: on it");
  });

  it("keeps a file-only message as a marker instead of dropping it", async () => {
    const api = fakeApi(
      [
        { user: "U1", text: "look at this", files: [{ name: "error.png" }] },
        { user: "U1", text: "", files: [{ name: "trace.log" }] },
      ],
      { U1: "Brian" },
    );
    const out = await fetchThreadTranscript(api, { channelId: "C1", threadTs: "1.0" });
    expect(out).toBe("Brian: look at this\nBrian: [shared: trace.log]");
  });

  it("attributes the bot's own prior replies as You", async () => {
    const api = fakeApi(
      [
        { user: "U1", text: "any update?" },
        { user: "UBOT", text: "shipped it" },
      ],
      { U1: "Brian" },
    );
    const out = await fetchThreadTranscript(api, { channelId: "C1", threadTs: "1.0", selfUserId: "UBOT" });
    expect(out).toBe("Brian: any update?\nYou: shipped it");
  });
});
