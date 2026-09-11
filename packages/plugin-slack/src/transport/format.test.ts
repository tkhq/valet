import { describe, it, expect } from "vitest";
import { markdownToSlackMrkdwn, neutralizeSlackMentions } from "./format.js";

describe("neutralizeSlackMentions", () => {
  it("defuses every broadcast sequence", () => {
    expect(neutralizeSlackMentions("<!channel>")).toBe("&lt;!channel>");
    expect(neutralizeSlackMentions("<!here>")).toBe("&lt;!here>");
    expect(neutralizeSlackMentions("<!everyone>")).toBe("&lt;!everyone>");
    expect(neutralizeSlackMentions("<!subteam^S123|@team>")).toBe("&lt;!subteam^S123|@team>");
  });

  it("defuses user and channel references", () => {
    expect(neutralizeSlackMentions("hi <@U0123>")).toBe("hi &lt;@U0123>");
    expect(neutralizeSlackMentions("see <#C0123|general>")).toBe("see &lt;#C0123|general>");
  });

  it("leaves ordinary angle brackets and markdown untouched", () => {
    // The mrkdwn escape would mangle all of these; markdown_text is standard
    // markdown, so only the ping-capable tokens are touched.
    expect(neutralizeSlackMentions("Array<string>")).toBe("Array<string>");
    expect(neutralizeSlackMentions("3 < 4 && 5 > 2")).toBe("3 < 4 && 5 > 2");
    expect(neutralizeSlackMentions("<div class='x'>")).toBe("<div class='x'>");
    expect(neutralizeSlackMentions("https://x.dev?a=1&b=2")).toBe("https://x.dev?a=1&b=2");
    expect(neutralizeSlackMentions("**bold** and `code`")).toBe("**bold** and `code`");
  });

  it("leaves an autolinked URL alone", () => {
    expect(neutralizeSlackMentions("<https://example.com>")).toBe("<https://example.com>");
  });
});

describe("markdownToSlackMrkdwn", () => {
  // ─── Bold ────────────────────────────────────────────────────────────

  it("converts **bold** to *bold*", () => {
    expect(markdownToSlackMrkdwn("**hello**")).toBe("*hello*");
  });

  it("converts __bold__ to *bold*", () => {
    expect(markdownToSlackMrkdwn("__hello__")).toBe("*hello*");
  });

  it("handles multiple bold spans", () => {
    expect(markdownToSlackMrkdwn("**a** and **b**")).toBe("*a* and *b*");
  });

  it("converts bold at the start, mid-line, and next to punctuation", () => {
    expect(markdownToSlackMrkdwn("**Start** then **middle** and (**end**)."))
      .toBe("*Start* then *middle* and (*end*).");
  });

  it("converts nested bold and italic emphasis", () => {
    expect(markdownToSlackMrkdwn("**bold and *italic***, then ***both***"))
      .toBe("*bold and _italic_*, then *_both_*");
  });

  // ─── Italic ──────────────────────────────────────────────────────────

  it("converts *italic* to _italic_", () => {
    expect(markdownToSlackMrkdwn("*hello*")).toBe("_hello_");
  });

  it("preserves _italic_ as _italic_", () => {
    expect(markdownToSlackMrkdwn("_hello_")).toBe("_hello_");
  });

  // ─── Mixed Bold + Italic ─────────────────────────────────────────────

  it("handles bold and italic together", () => {
    const result = markdownToSlackMrkdwn("**bold** and *italic*");
    expect(result).toBe("*bold* and _italic_");
  });

  // ─── Links ───────────────────────────────────────────────────────────

  it("converts markdown links to Slack format", () => {
    expect(markdownToSlackMrkdwn("[click](https://example.com)")).toBe("<https://example.com|click>");
  });

  it("handles links with bold text", () => {
    expect(markdownToSlackMrkdwn("[**bold link**](https://example.com)")).toBe(
      "<https://example.com|*bold link*>",
    );
  });

  // ─── Inline Code ─────────────────────────────────────────────────────

  it("preserves inline code", () => {
    expect(markdownToSlackMrkdwn("use `console.log`")).toBe("use `console.log`");
  });

  it("does not apply formatting inside inline code", () => {
    expect(markdownToSlackMrkdwn("`**not bold**`")).toBe("`**not bold**`");
  });

  // ─── Code Blocks ─────────────────────────────────────────────────────

  it("preserves fenced code blocks", () => {
    const input = "```\nconst x = 1;\n```";
    expect(markdownToSlackMrkdwn(input)).toBe("```const x = 1;```");
  });

  it("strips language identifier from fenced code blocks", () => {
    const input = "```js\nconst x = 1;\n```";
    expect(markdownToSlackMrkdwn(input)).toBe("```const x = 1;```");
  });

  it("does not apply formatting inside code blocks", () => {
    const input = "```\n**not bold** and *not italic*\n```";
    expect(markdownToSlackMrkdwn(input)).toBe("```**not bold** and *not italic*```");
  });

  // ─── Blockquotes ─────────────────────────────────────────────────────

  it("preserves blockquotes", () => {
    expect(markdownToSlackMrkdwn("> quoted text")).toBe("> quoted text");
  });

  it("converts headings and leaves lists readable", () => {
    expect(markdownToSlackMrkdwn("# Heading\n- item\n1. first")).toBe("*Heading*\n- item\n1. first");
  });

  it("converts a heading that contains bold text", () => {
    expect(markdownToSlackMrkdwn("# **Heading**")).toBe("*Heading*");
  });

  it("converts links inside bold text", () => {
    expect(markdownToSlackMrkdwn("See **[PR #631](https://github.com/tkhq/valet/pull/631)** for details"))
      .toBe("See *<https://github.com/tkhq/valet/pull/631|PR #631>* for details");
  });

  it("converts strikethrough", () => {
    expect(markdownToSlackMrkdwn("~~strike~~")).toBe("~strike~");
  });

  it("does not treat math and intraword underscores as emphasis", () => {
    expect(markdownToSlackMrkdwn("5 * 3 = 15 and 2 * 4 = 8")).toBe("5 * 3 = 15 and 2 * 4 = 8");
    expect(markdownToSlackMrkdwn("my__var__x")).toBe("my__var__x");
  });

  // ─── Plain Text ──────────────────────────────────────────────────────

  it("returns plain text unchanged", () => {
    expect(markdownToSlackMrkdwn("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(markdownToSlackMrkdwn("")).toBe("");
  });

  // ─── Complex / Mixed ─────────────────────────────────────────────────

  it("handles a realistic agent response", () => {
    const input = [
      "**Summary:** I found the bug.",
      "",
      "The issue is in `parser.ts` where `<input>` tags are not escaped:",
      "",
      "```ts",
      "function parse(html: string) {",
      '  return html.replace(/&/g, "&amp;");',
      "}",
      "```",
      "",
      "See [the docs](https://example.com) for more.",
    ].join("\n");

    const result = markdownToSlackMrkdwn(input);

    // Bold converted
    expect(result).toContain("*Summary:*");
    // Inline code preserved
    expect(result).toContain("`parser.ts`");
    expect(result).toContain("`<input>`");
    // Code block preserved
    expect(result).toContain("```");
    expect(result).toContain("function parse");
    // Link converted
    expect(result).toContain("<https://example.com|the docs>");
  });

  it("handles multiple code blocks", () => {
    const input = "```\nfirst\n```\ntext\n```\nsecond\n```";
    const result = markdownToSlackMrkdwn(input);
    expect(result).toContain("```first```");
    expect(result).toContain("```second```");
    expect(result).toContain("text");
  });

  it("converts the daily developer digest", () => {
    const digest = [
      "**Valet Daily Developer Digest: Unreleased Change**",
      "**Change:** fix(integrations): follow the selected team workspace",
      "**User Impact:** ...",
      "**Owner:** xBalbinus",
      "**PR:** https://github.com/tkhq/valet/pull/631",
    ].join("\n");
    expect(markdownToSlackMrkdwn(digest)).toBe([
      "*Valet Daily Developer Digest: Unreleased Change*",
      "*Change:* fix(integrations): follow the selected team workspace",
      "*User Impact:* ...",
      "*Owner:* xBalbinus",
      "*PR:* https://github.com/tkhq/valet/pull/631",
    ].join("\n"));
  });

  describe("control-sequence escaping (injection safety)", () => {
    it("preserves Slack-native mentions and specials", () => {
      expect(markdownToSlackMrkdwn("Heads up <!channel> deploying now")).toBe("Heads up <!channel> deploying now");
      expect(markdownToSlackMrkdwn("<!here> <@U0123> <#C0456|general> <!subteam^S123|@team>"))
        .toBe("<!here> <@U0123> <#C0456|general> <!subteam^S123|@team>");
    });

    it("preserves Slack-native links and converts Markdown links", () => {
      expect(markdownToSlackMrkdwn("<https://evil.example|Slack Support>"))
        .toBe("<https://evil.example|Slack Support>");
      expect(markdownToSlackMrkdwn("<https://example.com>")).toBe("<https://example.com>");
      expect(markdownToSlackMrkdwn("[docs](https://example.com)")).toBe("<https://example.com|docs>");
    });

    it("escapes ampersands in literal text", () => {
      expect(markdownToSlackMrkdwn("Tom & Jerry")).toBe("Tom &amp; Jerry");
    });

    it("does not escape control sequences inside code (Slack renders code literally)", () => {
      expect(markdownToSlackMrkdwn("`<@U0123>`")).toBe("`<@U0123>`");
      expect(markdownToSlackMrkdwn("```\n<!channel>\n```")).toBe("```<!channel>```");
    });

    it("still renders blockquotes (> is not escaped)", () => {
      expect(markdownToSlackMrkdwn("> quoted")).toBe("> quoted");
    });
  });
});
