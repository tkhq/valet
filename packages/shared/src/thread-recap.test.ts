import { describe, expect, it } from "vitest";
import { recapWindow, type RecapMessage } from "./thread-recap.js";

const reader = { id: "u-reader", name: "Reader" };
const teammate = { id: "u-mate", name: "Mate" };

let clock = 1_000;
function msg(role: "user" | "assistant", content: string, author?: RecapMessage["author"], extra: Partial<RecapMessage> = {}): RecapMessage {
  clock += 1_000;
  return { id: `m${clock}`, role, content, createdAt: clock, ...(author ? { author } : {}), ...extra };
}

describe("recapWindow", () => {
  it("covers what came after the last read when another person wrote", () => {
    clock = 1_000;
    const seen = [msg("user", "hi", reader), msg("assistant", "hello")];
    const readAt = clock;
    const fresh = [msg("user", "draft the email", teammate), msg("assistant", "Drafted."), msg("user", "send it", teammate), msg("assistant", "Sent.")];
    const span = recapWindow([...seen, ...fresh], reader.id, readAt);
    expect(span).toMatchObject({ mode: "away", since: readAt, people: ["Mate"], worthRecap: true });
    expect(span?.messages.map((m) => m.id)).toEqual(fresh.map((m) => m.id));
    expect(span?.earlier.map((m) => m.id)).toEqual(seen.map((m) => m.id));
  });

  it("shows nothing when only Valet wrote since the last read", () => {
    clock = 1_000;
    const seen = [msg("user", "run the report", reader)];
    const readAt = clock;
    expect(recapWindow([...seen, msg("assistant", "Report ready.")], reader.id, readAt)).toBeNull();
  });

  it("starts after the reader's own newer message even when the read time is older", () => {
    clock = 1_000;
    const messages = [msg("user", "a", teammate), msg("assistant", "b"), msg("user", "mine", reader), msg("assistant", "c")];
    expect(recapWindow(messages, reader.id, 0)).toBeNull();
  });

  it("treats a channel sender who runs as the reader as another person", () => {
    clock = 1_000;
    const readAt = clock;
    const span = recapWindow([msg("user", "from slack", { id: reader.id, name: "Guest", externalSender: true })], reader.id, readAt);
    expect(span?.people).toEqual(["Guest"]);
  });

  it("ignores team API keys, signals, and empty tool messages", () => {
    clock = 1_000;
    const readAt = clock;
    const messages = [
      msg("user", "scheduled run", { id: "team:t1", name: "Team key" }),
      msg("assistant", ""),
      msg("assistant", "child finished", undefined, { signal: { kind: "child.settled" } }),
    ];
    expect(recapWindow(messages, reader.id, readAt)).toBeNull();
  });

  it("recaps the whole thread for a reader who never opened or wrote in it", () => {
    clock = 1_000;
    const messages = [msg("user", "sync fails", teammate), msg("assistant", "403 at candidates")];
    expect(recapWindow(messages, reader.id, undefined)).toMatchObject({ mode: "first", earlier: [], worthRecap: false });
  });

  it("marks a short window as not worth a recap and a long one as worth it", () => {
    clock = 1_000;
    const short = recapWindow([msg("user", "quick q", teammate), msg("assistant", "quick a")], reader.id, 1_000);
    expect(short?.worthRecap).toBe(false);
    const long = recapWindow([msg("user", "x".repeat(1_300), teammate)], reader.id, 1_000);
    expect(long?.worthRecap).toBe(true);
  });
});
