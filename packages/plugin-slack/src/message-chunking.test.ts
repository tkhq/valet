import { describe, expect, it } from "vitest";
import { buildContentBlocks, needsContentBlocks, SLACK_TEXT_LIMIT, SLACK_MARKDOWN_LIMIT } from "./message-chunking.js";
import { markdownToSlackMrkdwn } from "./transport/format.js";

describe("GitHub references in content blocks", () => {
  it("links visible Markdown while retaining tables and bullet layout", () => {
    const text = "**Releases**\n\n- tkhq/gitops#5169\n- `tkhq/mono#8158`\n\n| State | Count |\n| --- | --- |\n| Merged | 1 |";
    expect(buildContentBlocks(text, markdownToSlackMrkdwn(text))).toEqual([{
      type: "markdown",
      text: text.replace("tkhq/gitops#5169", "[tkhq/gitops#5169](https://github.com/tkhq/gitops/issues/5169)"),
    }]);
  });

  it("uses the mrkdwn fallback when expanded links exceed the Markdown limit", () => {
    const text = "x".repeat(SLACK_MARKDOWN_LIMIT - 15) + " tkhq/mono#12";
    expect(text.length).toBeLessThanOrEqual(SLACK_MARKDOWN_LIMIT);
    const blocks = buildContentBlocks(text, markdownToSlackMrkdwn(text));
    expect(blocks.every((block) => block.type === "section")).toBe(true);
    expect(JSON.stringify(blocks)).toContain("<https://github.com/tkhq/mono/issues/12|tkhq/mono#12>");
  });
});


describe("block selection", () => {
  it("keeps action mentions but neutralizes broadcasts in generated blocks", () => {
    const text = '| Who |\n| --- |\n| <@U123> <!channel> <!here> <!everyone|all> |';
    expect(buildContentBlocks(text, markdownToSlackMrkdwn(text))).toEqual([{
      type: 'markdown',
      text: '| Who |\n| --- |\n| <@U123> &lt;!channel> &lt;!here> &lt;!everyone|all> |',
    }]);
  });

  it.each([
    '| PR | Merged |\n|---|---|\n| [mono#8240](https://github.com/tkhq/mono/pull/8240) | |',
    'PR | Merged\n:--- | ---:\nmono#8240 | yes',
    '| PR |\r\n| --- |\r\n| mono#8240 |',
  ])("uses blocks for short tables: %s", (text) => {
    expect(needsContentBlocks(text)).toBe(true);
  });

  it.each(['hello', 'a | b', '---', 'text\n| --- | prose |', 'x'.repeat(SLACK_TEXT_LIMIT)])(
    "keeps short prose on the text path: %s", (text) => {
      expect(needsContentBlocks(text)).toBe(false);
    },
  );

  it("keeps the long-message path", () => {
    expect(needsContentBlocks('x'.repeat(SLACK_TEXT_LIMIT + 1))).toBe(true);
  });
});
