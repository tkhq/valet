import { describe, expect, it } from "vitest";
import { buildContentBlocks, needsContentBlocks, SLACK_TEXT_LIMIT, SLACK_MARKDOWN_LIMIT } from "./message-chunking.js";
import { markdownToSlackMrkdwn } from "./transport/format.js";

describe("GitHub references in content blocks", () => {
  it("links visible Markdown while retaining tables and bullet layout", () => {
    const text = "**Releases**\n\n- tkhq/gitops#5169\n- `tkhq/mono#8158`\n\n| State | Count |\n| --- | --- |\n| Merged | 1 |";
    expect(buildContentBlocks(text, markdownToSlackMrkdwn(text))).toEqual([
      { type: "markdown", text: "**Releases**\n\n- [tkhq/gitops#5169](https://github.com/tkhq/gitops/issues/5169)\n- `tkhq/mono#8158`" },
      {
        type: "table",
        column_settings: [{ align: "left", is_wrapped: true }, { align: "left", is_wrapped: true }],
        rows: [
          [{ type: "raw_text", text: "State" }, { type: "raw_text", text: "Count" }],
          [
            { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "Merged" }] }] },
            { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "1" }] }] },
          ],
        ],
      },
    ]);
  });

  it("links references inside native table cells", () => {
    const text = "| PR | Related |\n| --- | --- |\n| tkhq/mono#8240 | tkhq/mono#8241<br>tkhq/mono#8242 |";
    const blocks = buildContentBlocks(text, markdownToSlackMrkdwn(text));
    expect(blocks[0]).toMatchObject({
      type: "table",
      rows: [[{ text: "PR" }, { text: "Related" }], [
        { elements: [{ elements: [{ type: "link", url: "https://github.com/tkhq/mono/issues/8240", text: "tkhq/mono#8240" }] }] },
        { elements: [{ elements: [
          { type: "link", url: "https://github.com/tkhq/mono/issues/8241", text: "tkhq/mono#8241" },
          { type: "text", text: "\n" },
          { type: "link", url: "https://github.com/tkhq/mono/issues/8242", text: "tkhq/mono#8242" },
        ] }] },
      ]],
    });
  });
});


describe("native table blocks", () => {
  const text = "Intro\n\n| a | b |\n|-|-|\n| 1 | 2 |";
  const blocksFor = (markdown: string, maxBlocks?: number) => buildContentBlocks(markdown, markdownToSlackMrkdwn(markdown), maxBlocks);
  const raw = (value: string) => ({ type: "raw_text", text: value });
  const cell = (...elements: Record<string, unknown>[]) => ({ type: "rich_text", elements: [{ type: "rich_text_section", elements }] });
  const plain = (value: string, style?: Record<string, boolean>) => (style ? { type: "text", text: value, style } : { type: "text", text: value });
  const link = (url: string, label: string) => ({ type: "link", url, text: label });
  const lineBreak = plain("\n");
  const column = { align: "left", is_wrapped: true };
  const types = (blocks: Record<string, unknown>[]) => blocks.map((block) => block.type);

  it("renders a pipe table as a table block with the prose around it as Markdown blocks", () => {
    const markdown = "**Release notes**\n\n| PR | Related |\n|---|---|\n| [mono#1](https://x/1) | [mono#2](https://x/2)<br>[mono#3](https://x/3) |\n\nThanks _all_";
    expect(blocksFor(markdown)).toEqual([
      { type: "markdown", text: "**Release notes**" },
      {
        type: "table",
        column_settings: [column, column],
        rows: [
          [raw("PR"), raw("Related")],
          [cell(link("https://x/1", "mono#1")), cell(link("https://x/2", "mono#2"), lineBreak, link("https://x/3", "mono#3"))],
        ],
      },
      { type: "markdown", text: "Thanks _all_" },
    ]);
  });

  it("turns <br> in a cell into a line break inside the cell", () => {
    const markdown = "| Notes |\n|---|\n| first<br>second <br/> third |";
    expect(blocksFor(markdown)).toEqual([{
      type: "table",
      column_settings: [column],
      rows: [[raw("Notes")], [cell(plain("first"), lineBreak, plain("second"), lineBreak, plain("third"))]],
    }]);
  });

  it("keeps <br> literal inside a code span and behind a backslash", () => {
    const markdown = "| Notes |\n|---|\n| `left<br>right` and \\<br> |";
    expect(blocksFor(markdown)).toEqual([{
      type: "table",
      column_settings: [column],
      rows: [[raw("Notes")], [cell(plain("left<br>right", { code: true }), plain(" and <br>"))]],
    }]);
  });

  it("maps inline formatting and links in a cell to rich text elements", () => {
    const markdown = "| Notes |\n|---|\n| **bold** _it_ ~~gone~~ `code` [label](https://x/1) https://example.com/a |";
    expect(blocksFor(markdown)).toEqual([{
      type: "table",
      column_settings: [column],
      rows: [[raw("Notes")], [cell(
        plain("bold", { bold: true }), plain(" "), plain("it", { italic: true }), plain(" "),
        plain("gone", { strike: true }), plain(" "), plain("code", { code: true }), plain(" "),
        link("https://x/1", "label"), plain(" "), link("https://example.com/a", "https://example.com/a"),
      )]],
    }]);
  });

  it("keeps a single Markdown block when native tables are disabled", () => {
    expect(buildContentBlocks(text, markdownToSlackMrkdwn(text), undefined, { nativeTables: false }))
      .toEqual([{ type: "markdown", text }]);
  });

  it("renders 100 rows as a table and keeps the Markdown block at 101", () => {
    const atLimit = "| a |\n|-|\n" + "| x |\n".repeat(99);
    const overLimit = "| a |\n|-|\n" + "| x |\n".repeat(100);
    expect(types(blocksFor(atLimit))).toEqual(["table"]);
    expect(blocksFor(overLimit)).toEqual([{ type: "markdown", text: overLimit }]);
  });

  it("renders 20 columns as a table and keeps the Markdown block at 21", () => {
    const table = (columns: number) => "|" + " a |".repeat(columns) + "\n|" + "-|".repeat(columns) + "\n|" + " 1 |".repeat(columns);
    expect(types(blocksFor(table(20)))).toEqual(["table"]);
    expect(blocksFor(table(21))).toEqual([{ type: "markdown", text: table(21) }]);
  });

  it("renders 10,000 cell characters as a table and keeps the Markdown block at 10,001", () => {
    const atLimit = "| a |\n|-|\n| " + "x".repeat(9_999) + " |";
    const overLimit = "| a |\n|-|\n| " + "x".repeat(10_000) + " |";
    expect(types(blocksFor(atLimit))).toEqual(["table"]);
    expect(blocksFor(overLimit)).toEqual([{ type: "markdown", text: overLimit }]);
  });

  it("keeps the Markdown block when a cell exceeds the parse budget", () => {
    const withinBudget = "| a |\n|-|\n| " + "[x](https://x/1) ".repeat(12) + "|";
    const overBudget = "| a |\n|-|\n| " + "![".repeat(300) + "]()".repeat(300) + " |";
    expect(types(blocksFor(withinBudget))).toEqual(["table"]);
    expect(blocksFor(overBudget)).toEqual([{ type: "markdown", text: overBudget }]);
  });

  it("keeps the Markdown block when the table blocks exceed the block budget", () => {
    expect(types(blocksFor(text, 2))).toEqual(["markdown", "table"]);
    expect(blocksFor(text, 1)).toEqual([{ type: "markdown", text }]);
  });
});


describe("GitHub references beyond the Markdown limit", () => {
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
