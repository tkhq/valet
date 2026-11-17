import { describe, expect, it } from "vitest";
import { MESSAGE_CONTENT_MAX_CHARS, slackMessageExtraText } from "./message-text.js";

describe("slackMessageExtraText", () => {
  it("is empty for a plain message", () => {
    expect(slackMessageExtraText({ text: "hello" })).toBe("");
  });

  it("ignores the rich_text mirror of a person's message", () => {
    const msg = {
      user: "U1",
      text: "see <https://example.com|the doc>",
      blocks: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [
        { type: "text", text: "see " }, { type: "link", url: "https://example.com", text: "the doc" },
      ] }] }],
    };
    expect(slackMessageExtraText(msg)).toBe("");
  });

  it("reads header, section fields, and context, without repeating text", () => {
    const msg = {
      bot_id: "B1",
      text: "Deal update",
      blocks: [
        { type: "header", text: { type: "plain_text", text: "Deal update" } },
        { type: "section", fields: [{ type: "mrkdwn", text: "*Promotion:* SPRING25" }, { type: "mrkdwn", text: "*Region:* EU" }] },
        { type: "divider" },
        { type: "context", elements: [{ type: "mrkdwn", text: "Posted by" }, { type: "image", image_url: "x", alt_text: "logo" }, { type: "plain_text", text: "Deals bot" }] },
      ],
    };
    expect(slackMessageExtraText(msg)).toBe("*Promotion:* SPRING25\n*Region:* EU\nPosted by Deals bot");
  });

  it("reads a bot's rich_text lists, quotes, and mentions", () => {
    const msg = {
      bot_id: "B1",
      text: "Summary",
      blocks: [{ type: "rich_text", elements: [
        { type: "rich_text_list", style: "ordered", elements: [
          { type: "rich_text_section", elements: [{ type: "text", text: "first for " }, { type: "user", user_id: "U9" }] },
          { type: "rich_text_section", elements: [{ type: "text", text: "second" }] },
        ] },
        { type: "rich_text_quote", elements: [{ type: "text", text: "quoted" }] },
      ] }],
    };
    expect(slackMessageExtraText(msg)).toBe("1. first for <@U9>\n2. second\n> quoted");
  });

  it("reads legacy attachments and uses fallback only when nothing else is there", () => {
    const msg = {
      text: "",
      attachments: [
        { pretext: "Heads up", title: "Order 42", title_link: "https://x.test/42", text: "Shipped", fields: [{ title: "Carrier", value: "UPS" }], fallback: "ignored" },
        { fallback: "Only fallback" },
      ],
    };
    expect(slackMessageExtraText(msg)).toBe("Heads up\nOrder 42 (https://x.test/42)\nShipped\nCarrier: UPS\nOnly fallback");
  });

  it("caps long content", () => {
    const msg = { bot_id: "B1", text: "", blocks: [{ type: "section", text: { type: "mrkdwn", text: "a".repeat(MESSAGE_CONTENT_MAX_CHARS + 50) } }] };
    const out = slackMessageExtraText(msg);
    expect(out.length).toBe(MESSAGE_CONTENT_MAX_CHARS + 1);
    expect(out.endsWith("…")).toBe(true);
  });
});
