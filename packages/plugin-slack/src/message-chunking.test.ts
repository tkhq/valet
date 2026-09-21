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
    expect(buildContentBlocks(text, markdownToSlackMrkdwn(text), undefined, { preserveSlackNativeSpans: true })).toEqual([{
      type: 'section',
      text: { type: 'mrkdwn', text: '*Who*: <@U123> &lt;!channel> &lt;!here> &lt;!everyone|all>\n' },
    }]);
  });

  it.each([
    '| a | b |\n|-|-|\n| 1 | 2 |',
    '| a | b |\n|--|--|\n| 1 | 2 |',
    '| a | b |\n|:-|-:|\n| 1 | 2 |',
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


describe("Slack spans in generated blocks", () => {
  it.each(['<!group>', '<!group|all>', '<!channel>', '<!future>'])(
    'uses the existing control-token policy for %s', (token) => {
      const text = `| Who |\n|-|\n| ${token} |`;
      expect(buildContentBlocks(text, markdownToSlackMrkdwn(text), undefined, { preserveSlackNativeSpans: true })).toEqual([{
        type: 'section', text: { type: 'mrkdwn', text: `*Who*: ${token.replace('<', '&lt;')}\n` },
      }]);
    },
  );

  it("preserves native action spans in labeled rows without splitting their labels", () => {
    const text = '**Release**\n\n| Owner | Doc | Channel | Merged |\n| - | - | - | - |\n| <@U123> | <https://example.com|the doc> | <#C0123|general> | |\n| <!subteam^S123|team> | [PR](https://github.com/tkhq/mono/pull/8240) | <#C456> | yes |';
    expect(buildContentBlocks(text, markdownToSlackMrkdwn(text), undefined, { preserveSlackNativeSpans: true })).toEqual([{
      type: 'section', text: { type: 'mrkdwn', text: '*Release*\n\n*Owner*: <@U123>\n*Doc*: <https://example.com|the doc>\n*Channel*: <#C0123|general>\n*Merged*: \n\n*Owner*: <!subteam^S123|team>\n*Doc*: <https://github.com/tkhq/mono/pull/8240|PR>\n*Channel*: <#C456>\n*Merged*: yes\n' },
    }]);
  });

  it("keeps transport spans inert with the default policy", () => {
    const text = '| Owner |\n|-|\n| <@U123> <#C0123|general> <!group> |';
    expect(buildContentBlocks(text, markdownToSlackMrkdwn(text))).toEqual([{
      type: 'section', text: { type: 'mrkdwn', text: '*Owner*: &lt;@U123> &lt;#C0123|general> &lt;!group>\n' },
    }]);
  });

  it("honors the section size and block count limits", () => {
    const text = '| Doc | Notes |\n|-|-|\n| <https://example.com|doc> | ' + 'x'.repeat(9000) + ' |';
    const blocks = buildContentBlocks(text, markdownToSlackMrkdwn(text), 2, { preserveSlackNativeSpans: true });
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block.type).toBe('section');
      expect(JSON.stringify(block).length).toBeLessThan(3100);
    }
  });
});


describe('native span boundaries', () => {
  it('retains a prefix of oversized single-line prose with native spans', () => {
    const text = '<@U123> ' + 'x'.repeat(9000);
    const blocks = buildContentBlocks(text, markdownToSlackMrkdwn(text), 2, { preserveSlackNativeSpans: true });
    expect(blocks).toHaveLength(2);
    expect(JSON.stringify(blocks)).toContain('<@U123>');
    expect(JSON.stringify(blocks)).toContain('x'.repeat(2000));
    expect(JSON.stringify(blocks)).toContain('Message truncated to fit Slack block limits.');
  });

  it.each(['<@U123>', '<#C123|general>', '<!subteam^S123|team>', '<https://example.com|doc>'])(
    'keeps %s whole when rows cross the section limit', (span) => {
      const text = '|a|\n|-|\n|' + 'x'.repeat(2993) + span + '|';
      const blocks = buildContentBlocks(text, markdownToSlackMrkdwn(text), undefined, { preserveSlackNativeSpans: true });
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toEqual({ type: 'section', text: { type: 'mrkdwn', text: '*a*: ' + 'x'.repeat(2993) } });
      expect(blocks[1]).toEqual({ type: 'section', text: { type: 'mrkdwn', text: span + '\n' } });
    },
  );

  it('reports truncation when expanded rows exceed the block budget', () => {
    const text = '|h|\n|-|\n|<@U123>|\n' + '|x|\n'.repeat(3000);
    const blocks = buildContentBlocks(text, markdownToSlackMrkdwn(text), 1, { preserveSlackNativeSpans: true });
    expect(blocks).toHaveLength(1);
    expect(JSON.stringify(blocks)).toContain('Message truncated to fit Slack block limits.');
    expect(JSON.stringify(blocks)).toContain('<@U123>');
  });
});
