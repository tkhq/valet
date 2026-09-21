import { beforeEach, describe, expect, it, vi } from "vitest";
import { fromMarkdown } from "mdast-util-from-markdown";
import { linkGitHubReferencesInMarkdown } from "./format.js";
import { buildContentBlocks } from "../message-chunking.js";

vi.mock("mdast-util-from-markdown", async (importOriginal) => {
  const original = await importOriginal<typeof import("mdast-util-from-markdown")>();
  return { ...original, fromMarkdown: vi.fn(original.fromMarkdown) };
});

describe("Markdown autolinking work budget", () => {
  beforeEach(() => vi.mocked(fromMarkdown).mockClear());

  it.each([
    "![".repeat(2400) + "]()".repeat(2400),
    "![".repeat(2397) + "]()".repeat(2397) + " tkhq/mono#12",
    "> ".repeat(300) + "tkhq/mono#12",
    "a\n".repeat(300) + "tkhq/mono#12",
    "x".repeat(12_000) + " tkhq/mono#12",
  ])("does not invoke the parser for adversarial or oversized input %#", (text) => {
    expect(linkGitHubReferencesInMarkdown(text)).toBe(text);
    expect(fromMarkdown).not.toHaveBeenCalled();
  });

  it("preserves an explicit link in a complex visible message block", () => {
    const text = "![".repeat(2300) + "]()".repeat(2300)
      + "\n[PR #12](https://github.com/tkhq/mono/pull/12) tkhq/mono#13";
    expect(buildContentBlocks(text, "notification fallback")).toEqual([{ type: "markdown", text }]);
    expect(fromMarkdown).not.toHaveBeenCalled();
  });

  it("still parses and links an ordinary report", () => {
    const text = "**Releases**\n\n- tkhq/gitops#5169\n- `tkhq/mono#8158`";
    expect(linkGitHubReferencesInMarkdown(text)).toBe(
      "**Releases**\n\n- [tkhq/gitops#5169](https://github.com/tkhq/gitops/issues/5169)\n- `tkhq/mono#8158`",
    );
    expect(fromMarkdown).toHaveBeenCalledOnce();
  });

  it("admits 256 syntax characters but bypasses the parser at 257", () => {
    const text = "[x]".repeat(127) + " tkhq/mono#12";
    expect(linkGitHubReferencesInMarkdown(text)).toContain(
      "[tkhq/mono#12](https://github.com/tkhq/mono/issues/12)",
    );
    expect(fromMarkdown).toHaveBeenCalledOnce();
    vi.mocked(fromMarkdown).mockClear();
    expect(linkGitHubReferencesInMarkdown("!" + text)).toBe("!" + text);
    expect(fromMarkdown).not.toHaveBeenCalled();
  });
});
