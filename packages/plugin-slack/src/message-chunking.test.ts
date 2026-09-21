import { describe, expect, it } from "vitest";
import { buildContentBlocks, SLACK_MARKDOWN_LIMIT } from "./message-chunking.js";
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
