import { describe, expect, it } from "vitest";
import { markdownToTelegramHtml } from "./format.js";

describe("markdownToTelegramHtml", () => {
  it("escapes HTML entities", () => {
    expect(markdownToTelegramHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });
  it("renders bold and italic", () => {
    expect(markdownToTelegramHtml("**bold** and *ital*")).toBe("<b>bold</b> and <i>ital</i>");
  });
  it("renders links", () => {
    expect(markdownToTelegramHtml("[x](https://e.co)")).toBe('<a href="https://e.co">x</a>');
  });
  it("protects fenced code blocks from formatting", () => {
    expect(markdownToTelegramHtml("```\n**not bold** <tag>\n```")).toBe(
      "<pre>**not bold** &lt;tag&gt;</pre>",
    );
  });
  it("protects inline code", () => {
    expect(markdownToTelegramHtml("run `a && b` now")).toBe("run <code>a &amp;&amp; b</code> now");
  });
});
