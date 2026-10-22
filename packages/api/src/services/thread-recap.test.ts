import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecapMessage } from "@valet/shared";
import { clearThreadRecapCache, fitToReader, parseRecapPoints, recapPrompt, threadRecap } from "./thread-recap.js";

const reader = { id: "u-reader", name: "Reader" };
const teammate = { id: "u-mate", name: "Mate" };

function thread(): RecapMessage[] {
  return [
    { id: "m1", role: "user", content: "pull the SOC 2 report", createdAt: 1_000, author: reader },
    { id: "m2", role: "assistant", content: "Done.", createdAt: 2_000 },
    { id: "m3", role: "user", content: "fill out the Acme questionnaire", createdAt: 10_000, author: teammate },
    { id: "m4", role: "assistant", content: "38 of 42 answers drafted.", createdAt: 11_000 },
    { id: "m5", role: "user", content: "send the draft", createdAt: 12_000, author: teammate },
    { id: "m6", role: "assistant", content: "Sent. Attach the pen-test summary too?", createdAt: 13_000 },
    { id: "m7", role: "user", content: "ask Reader", createdAt: 14_000, author: teammate },
  ];
}

describe("parseRecapPoints", () => {
  it("keeps three points, puts the reader's point first, and strips markdown", () => {
    const reply = 'Here: {"points":[{"text":"**Drafted** 38 answers","forReader":false},{"text":"Sent the draft"},{"text":"Decide on the pen-test summary","forReader":true},{"text":"extra"}]}';
    expect(parseRecapPoints(reply)).toEqual([
      { text: "Decide on the pen-test summary", forReader: true },
      { text: "Drafted 38 answers" },
      { text: "Sent the draft" },
    ]);
  });

  it("throws on a reply with no usable point", () => {
    expect(() => parseRecapPoints("no json")).toThrow(/no JSON object/);
    expect(() => parseRecapPoints('{"points":[{"text":"  "}]}')).toThrow(/no usable point/);
  });
});

describe("fitToReader", () => {
  const span = (messages: RecapMessage[]) => ({ mode: "away" as const, since: 5_000, messages, earlier: [], people: ["Mate"], worthRecap: true });

  it("drops a waiting-on-you point when no recapped message names the reader", () => {
    const points = [{ text: "Check the launch claim before publishing.", forReader: true }, { text: "Valet drafted the post." }];
    expect(fitToReader(points, span(thread().slice(2, 6)), "Reader Person")).toEqual([{ text: "Valet drafted the post." }]);
  });

  it("keeps it when a message names the reader, and writes the reader's name as you", () => {
    const points = [{ text: "Decide on the pen-test summary.", forReader: true }, { text: "Valet is waiting on Reader's answer for Reader." }];
    expect(fitToReader(points, span(thread().slice(2)), "Reader Person")).toEqual([
      { text: "Decide on the pen-test summary.", forReader: true },
      { text: "Valet is waiting on your answer for you." },
    ]);
  });
});

describe("recapPrompt", () => {
  it("names the reader, gives earlier messages as context, and lists the new ones", () => {
    const prompt = recapPrompt({
      mode: "away", since: 5_000, messages: thread().slice(2), earlier: thread().slice(0, 2), people: ["Mate"], worthRecap: true,
    }, reader.id, "Reader");
    expect(prompt).toContain("The reader is Reader.");
    expect(prompt).toContain("Recap only the NEW MESSAGES.");
    expect(prompt).toContain("Reader (the reader), 1970-01-01 00:00 UTC] pull the SOC 2 report");
    expect(prompt.indexOf("NEW MESSAGES:")).toBeLessThan(prompt.indexOf("[Mate,"));
    expect(prompt).toContain("[Valet, ");
  });
});

describe("threadRecap", () => {
  beforeEach(() => clearThreadRecapCache());

  it("returns null without a model call when only the reader and Valet wrote", async () => {
    const write = vi.fn();
    await expect(threadRecap({ threadId: "t1", messages: thread().slice(0, 2), readerId: reader.id, readerName: "Reader", readAt: 1_500, write }))
      .resolves.toEqual({ recap: null });
    expect(write).not.toHaveBeenCalled();
  });

  it("writes a recap once per window and reuses it", async () => {
    const write = vi.fn(async () => '{"points":[{"text":"Mate had Valet draft and send the Acme answers."}]}');
    const input = { threadId: "t1", messages: thread(), readerId: reader.id, readerName: "Reader", readAt: 5_000, write };
    await expect(threadRecap(input)).resolves.toEqual({ recap: { mode: "away", points: [{ text: "Mate had Valet draft and send the Acme answers." }] } });
    await threadRecap(input);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("shows no recap when the only point was an unbacked ask of the reader", async () => {
    const write = vi.fn(async () => '{"points":[{"text":"Approve the send.","forReader":true}]}');
    const messages = thread().slice(0, 6);
    await expect(threadRecap({ threadId: "t1", messages, readerId: reader.id, readerName: "Reader", readAt: 5_000, write }))
      .resolves.toEqual({ recap: null });
  });

  it("does not keep a failed recap", async () => {
    const write = vi.fn(async () => "not json");
    const input = { threadId: "t1", messages: thread(), readerId: reader.id, readerName: "Reader", readAt: 5_000, write };
    await expect(threadRecap(input)).rejects.toThrow();
    await expect(threadRecap(input)).rejects.toThrow();
    expect(write).toHaveBeenCalledTimes(2);
  });
});
