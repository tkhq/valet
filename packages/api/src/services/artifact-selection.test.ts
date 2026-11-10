import { describe, expect, it } from "vitest";
import { resolveArtifactSelection } from "./artifact-selection.js";

describe("preview selection source mapping", () => {
  it("rejects raw attribute matches outside the selected HTML element", () => {
    const content = '<p data-vdid="actual">Hello <strong>world</strong></p><p title="Hello world">Unchanged</p>';
    expect(() => resolveArtifactSelection(content, "html", { kind: "text", text: "Hello world", vdid: "actual" })).toThrow(/Source|source/);
  });
  it("rejects raw matches in Markdown link titles when the visible anchor contains formatting", () => {
    const content = 'Hello **world**\n\n![Picture](https://example.test "Hello world")';
    expect(() => resolveArtifactSelection(content, "markdown", { kind: "text", text: "Hello world", vdid: "4ab70e292b8580a1" })).toThrow(/Source|source/);
  });
  it("selects a raw HTML text node within its anchor, ignoring equal attribute text", () => {
    const content = '<p title="Hello world">Keep</p><p data-vdid="actual">Hello world</p>';
    const selection = resolveArtifactSelection(content, "html", { kind: "text", text: "Hello world", vdid: "actual" });
    expect(selection).toEqual({ start: content.lastIndexOf("Hello world"), end: content.lastIndexOf("Hello world") + 11, oldText: "Hello world" });
  });
  it("resolves generated element ids in DOM order, including repeated elements", () => {
    const content = '<p>Repeated</p><p>Repeated</p>';
    const selection = resolveArtifactSelection(content, "html", { kind: "element", text: "Repeated", vdid: "088e2b5a509d52d6" });
    expect(selection).toEqual({ start: 15, end: 30, oldText: "<p>Repeated</p>" });
  });
  it("maps plain Markdown heading/paragraph selections while rejecting missing anchors", () => {
    const content = '# Project brief\n\nA simple paragraph.';
    expect(resolveArtifactSelection(content, "markdown", { text: "simple", vdid: "9fea7aa011edb8f8" }).oldText).toBe("simple");
    expect(() => resolveArtifactSelection(content, "markdown", { text: "simple", vdid: "forged" })).toThrow(/Source|source/);
  });
  it("requires Source fallback for encoded HTML text and rejects script matches", () => {
    expect(() => resolveArtifactSelection('<p data-vdid="actual">A &amp; B</p><script>A & B</script>', "html", { text: "A & B", vdid: "actual" })).toThrow(/Source|source/);
    expect(() => resolveArtifactSelection('<script>secret</script><p>Visible</p>', "html", { text: "secret" })).toThrow(/Source|source/);
  });
  it("does not map a formatted Markdown anchor onto an identical later plain block", () => {
    for (const content of ['Hello **world**\n\nHello world\n', '<p data-vdid="actual">Hello <strong>world</strong></p>\n\nHello world\n']) {
      const vdid = content.startsWith('<') ? "actual" : "4ab70e292b8580a1";
      expect(() => resolveArtifactSelection(content, "markdown", { text: "Hello world", vdid })).toThrow(/Source|source/);
    }
  });

  it("rejects preview text without an anchor instead of targeting an unrelated plain occurrence", () => {
    expect(() => resolveArtifactSelection('<span>Hello <strong>world</strong></span><p>Hello world</p>', "html", { kind: "text", text: "Hello world" })).toThrow(/Source|source/);
    expect(() => resolveArtifactSelection('<div><p style="display:inline">Hello</p><p style="display:inline"> world</p></div>\n\nHello world\n', "markdown", { kind: "text", text: "Hello world" })).toThrow(/Source|source/);
  });

});
