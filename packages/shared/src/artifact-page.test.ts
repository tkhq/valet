import { describe, expect, it } from "vitest";
import {
  ARTIFACT_CSP,
  ARTIFACT_DS_RUNTIME_JS,
  ARTIFACT_FRAME_SANDBOX,
  ARTIFACT_MAX_CONTENT_BYTES,
  ARTIFACT_RUNTIME_JS,
  artifactFaviconDataUri,
  artifactSizeError,
  artifactSizeErrorForBytes,
  buildArtifactDocument,
  extractHtmlTitle,
  extractMarkdownTitle,
  isArtifactFormat,
  normalizeArtifactIcon,
  resolveArtifactTitle,
} from "./artifact-page.js";

describe("policy constants", () => {
  it("denies network egress and every default source", () => {
    // The two directives the containment story rests on. A change here is a
    // change to the threat model, not a refactor.
    expect(ARTIFACT_CSP).toContain("default-src 'none'");
    expect(ARTIFACT_CSP).toContain("connect-src 'none'");
    expect(ARTIFACT_CSP).toContain("form-action 'none'");
    expect(ARTIFACT_CSP).toContain("base-uri 'none'");
  });

  it("allows only the two named script CDNs", () => {
    const scriptSrc = ARTIFACT_CSP.split("; ").find((d) => d.startsWith("script-src "));
    expect(scriptSrc).toBeDefined();
    const hosts = (scriptSrc ?? "").match(/https:\/\/[^\s;]+/g) ?? [];
    expect(hosts).toEqual(["https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"]);
  });

  it("never grants the frame same-origin or top navigation", () => {
    expect(ARTIFACT_FRAME_SANDBOX).not.toContain("allow-same-origin");
    expect(ARTIFACT_FRAME_SANDBOX).not.toContain("allow-top-navigation");
    expect(ARTIFACT_FRAME_SANDBOX).toContain("allow-scripts");
  });
});

describe("isArtifactFormat", () => {
  it("accepts the two formats and nothing else", () => {
    expect(isArtifactFormat("markdown")).toBe(true);
    expect(isArtifactFormat("html")).toBe(true);
    expect(isArtifactFormat("htm")).toBe(false);
    expect(isArtifactFormat(undefined)).toBe(false);
  });
});

describe("artifactSizeError", () => {
  it("passes content within the cap", () => {
    expect(artifactSizeError("# hello")).toBeNull();
  });

  it("names the size, the limit, and the corrective action", () => {
    const oversized = "x".repeat(ARTIFACT_MAX_CONTENT_BYTES + 1);
    const message = artifactSizeError(oversized);
    expect(message).toContain("2 MiB limit");
    expect(message).toContain("inline SVG");
  });

  it("measures UTF-8 bytes, not code units", () => {
    // Four bytes each, so a quarter of the cap in characters is exactly at it.
    const atCap = "😀".repeat(ARTIFACT_MAX_CONTENT_BYTES / 4);
    expect(artifactSizeError(atCap)).toBeNull();
    expect(artifactSizeError(atCap + "😀")).not.toBeNull();
  });
});

describe("artifactSizeErrorForBytes", () => {
  it("passes a byte count within the cap", () => {
    expect(artifactSizeErrorForBytes(ARTIFACT_MAX_CONTENT_BYTES)).toBeNull();
  });

  it("names the size, the limit, and the corrective action for an over-cap byte count", () => {
    const message = artifactSizeErrorForBytes(ARTIFACT_MAX_CONTENT_BYTES + 1);
    expect(message).toContain("2 MiB limit");
    expect(message).toContain("inline SVG");
  });

  it("is the single source of the wording artifactSizeError delegates to", () => {
    const oversized = "x".repeat(ARTIFACT_MAX_CONTENT_BYTES + 1);
    expect(artifactSizeError(oversized)).toBe(artifactSizeErrorForBytes(ARTIFACT_MAX_CONTENT_BYTES + 1));
  });
});

describe("extractHtmlTitle", () => {
  it("reads the title element", () => {
    expect(extractHtmlTitle("<html><head><title>Deploy board</title></head></html>")).toBe(
      "Deploy board",
    );
  });

  it("decodes entities and collapses whitespace", () => {
    expect(extractHtmlTitle("<title>Ops\n  &amp;  SRE</title>")).toBe("Ops & SRE");
  });

  it("ignores a title buried past the head-sized prefix", () => {
    const padded = `<!doctype html>${" ".repeat(9000)}<title>Too late</title>`;
    expect(extractHtmlTitle(padded)).toBeUndefined();
  });

  it("returns undefined for an empty title", () => {
    expect(extractHtmlTitle("<title>   </title>")).toBeUndefined();
  });
});

describe("extractMarkdownTitle", () => {
  it("takes the first heading at any level", () => {
    expect(extractMarkdownTitle("intro\n\n## Findings\n\n# Later")).toBe("Findings");
  });

  it("strips closing hashes", () => {
    expect(extractMarkdownTitle("# Report #")).toBe("Report");
  });

  it("returns undefined with no heading", () => {
    expect(extractMarkdownTitle("plain prose only")).toBeUndefined();
  });
});

describe("resolveArtifactTitle", () => {
  const base = { content: "<title>From doc</title>", format: "html" as const, key: "pages/board.html" };

  it("prefers an explicit title", () => {
    expect(resolveArtifactTitle({ ...base, explicit: "  Chosen  " })).toBe("Chosen");
  });

  it("falls back to the document's own title", () => {
    expect(resolveArtifactTitle(base)).toBe("From doc");
  });

  it("falls back to the key basename without its extension", () => {
    expect(resolveArtifactTitle({ ...base, content: "<p>no title</p>" })).toBe("board");
  });

  it("never returns an empty title", () => {
    expect(resolveArtifactTitle({ content: "", format: "markdown", key: "/" })).toBe("Untitled");
  });

  it("reads markdown headings when the format says markdown", () => {
    expect(
      resolveArtifactTitle({ content: "# Weekly\n\nbody", format: "markdown", key: "notes/w.md" }),
    ).toBe("Weekly");
  });
});

describe("normalizeArtifactIcon", () => {
  it("accepts one or two emoji", () => {
    expect(normalizeArtifactIcon("📊")).toBe("📊");
    expect(normalizeArtifactIcon("⚡🔥")).toBe("⚡🔥");
  });

  it("treats a ZWJ sequence as one glyph", () => {
    expect(normalizeArtifactIcon("👩‍💻")).toBe("👩‍💻");
  });

  it("drops three or more glyphs", () => {
    expect(normalizeArtifactIcon("📊⚡🔥")).toBe("");
  });

  it("drops letters, markup, and quotes rather than escaping them", () => {
    expect(normalizeArtifactIcon("ab")).toBe("");
    expect(normalizeArtifactIcon("<svg>")).toBe("");
    expect(normalizeArtifactIcon('"')).toBe("");
    expect(normalizeArtifactIcon(undefined)).toBe("");
  });
});

describe("artifactFaviconDataUri", () => {
  it("builds an SVG data URI for a valid icon", () => {
    const uri = artifactFaviconDataUri("📊");
    expect(uri?.startsWith("data:image/svg+xml,")).toBe(true);
    expect(decodeURIComponent(uri ?? "")).toContain("📊");
  });

  it("returns undefined for a rejected icon", () => {
    expect(artifactFaviconDataUri("not-an-emoji")).toBeUndefined();
  });
});

describe("buildArtifactDocument", () => {
  it("wraps a fragment in a full document carrying the policy", () => {
    const html = buildArtifactDocument({ title: "Board", content: "<h1>Hi</h1>" });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain(`http-equiv="Content-Security-Policy"`);
    expect(html).toContain("connect-src &#39;none&#39;");
    expect(html).toContain("<title>Board</title>");
    expect(html).toContain("<h1>Hi</h1>");
  });

  it("escapes the title, so a hostile title cannot close the tag", () => {
    const html = buildArtifactDocument({
      title: `</title><script>alert(1)</script>`,
      content: "<p>x</p>",
    });
    expect(html).not.toContain("</title><script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("puts Valet's head before EVERY artifact byte, full documents included", () => {
    const content = `<!doctype html><html><head><title>Own</title></head><body><p>x</p></body></html>`;
    const html = buildArtifactDocument({ title: "Shell", content });
    const cspAt = html.indexOf(`http-equiv="Content-Security-Policy"`);
    expect(cspAt).toBeGreaterThan(-1);
    expect(cspAt).toBeLessThan(html.indexOf(content));
  });

  it("cannot be decoyed into placing the CSP inside a comment", () => {
    // The attack the always-first ordering exists to kill: a fake <head>
    // inside a comment ahead of the real one. Any head-locating splice puts
    // the CSP into dead text; emitting our head first makes the decoy inert.
    const content = `<!doctype html>\n<html>\n<!--<head>-->\n<head><script>exfil()</script></head>\n<body>x</body>\n</html>`;
    const html = buildArtifactDocument({ title: "T", content });
    const cspAt = html.indexOf(`http-equiv="Content-Security-Policy"`);
    expect(cspAt).toBeGreaterThan(-1);
    // The policy precedes the artifact's first byte — comment, script, all
    // of it — so it cannot land inside attacker-controlled dead text.
    expect(cspAt).toBeLessThan(html.indexOf("<!--"));
    expect(cspAt).toBeLessThan(html.indexOf("exfil()"));
  });

  it("emits the description and favicon only when present", () => {
    const bare = buildArtifactDocument({ title: "T", content: "<p>x</p>" });
    expect(bare).not.toContain(`name="description"`);
    expect(bare).not.toContain(`rel="icon"`);

    const full = buildArtifactDocument({
      title: "T",
      content: "<p>x</p>",
      description: "Deploy failures by service",
      icon: "📊",
    });
    expect(full).toContain(`name="description" content="Deploy failures by service"`);
    expect(full).toContain(`rel="icon"`);
  });

  it("includes the comment runtime only when asked", () => {
    const withRuntime = buildArtifactDocument({ title: "T", content: "<p>x</p>", runtime: true });
    expect(withRuntime).toContain("valet-artifact:ready");
    const download = buildArtifactDocument({ title: "T", content: "<p>x</p>" });
    expect(download).not.toContain("valet-artifact:ready");
  });

  it("bridges Mermaid blocks to the parent renderer and preserves failures", () => {
    const page = buildArtifactDocument({
      title: "Flow",
      content: '<pre><code class="language-mermaid">graph TD; A--&gt;B</code></pre>',
      runtime: true,
    });
    expect(page).toContain("pre > code.language-mermaid");
    expect(page).toContain("valet-artifact:mermaid");
    expect(page).toContain("valet-artifact:mermaid-result");
    expect(page).toContain("The source is shown below.");
  });

  it("includes the chart runtime and palette on every page, downloads included", () => {
    const download = buildArtifactDocument({ title: "T", content: "<p>x</p>" });
    expect(download).toContain("window.valetDS");
    expect(download).toContain("--artifact-chart-1");
    // The dark palette redefines the chart tokens too.
    const dark = download.slice(download.indexOf("@media"));
    expect(dark).toContain("--artifact-chart-1");
  });

  it("ships runtimes that cannot terminate their own script tags", () => {
    // A `</script>` inside an inline runtime would end the tag early and
    // dump the rest as markup.
    expect(ARTIFACT_RUNTIME_JS.toLowerCase()).not.toContain("</script");
    expect(ARTIFACT_DS_RUNTIME_JS.toLowerCase()).not.toContain("</script");
  });

  it("marks every page noindex", () => {
    expect(buildArtifactDocument({ title: "T", content: "" })).toContain(
      `<meta name="robots" content="noindex">`,
    );
  });

  it("defines the light palette outside the dark media query", () => {
    const html = buildArtifactDocument({ title: "T", content: "" });
    const beforeMedia = html.slice(0, html.indexOf("@media"));
    expect(beforeMedia).toContain("--artifact-bg: #ffffff");
    expect(html).toContain("background: var(--artifact-bg)");
  });
});

describe("theming", () => {
  it("stamps data-theme when a theme is given", () => {
    const doc = buildArtifactDocument({ title: "T", content: "<p>x</p>", theme: "dark" });
    expect(doc).toContain('<html lang="en" data-theme="dark">');
  });

  it("leaves the root unstamped for the system default", () => {
    const doc = buildArtifactDocument({ title: "T", content: "<p>x</p>" });
    expect(doc).toContain('<html lang="en">');
    expect(doc).not.toContain('<html lang="en" data-theme');
  });

  it("guards the media-query dark block against an explicit light choice", () => {
    const doc = buildArtifactDocument({ title: "T", content: "<p>x</p>" });
    expect(doc).toContain(':root:not([data-theme="light"])');
    expect(doc).toContain(':root[data-theme="dark"]');
  });

  it("ships a theme handler in the runtime", () => {
    expect(ARTIFACT_RUNTIME_JS).toContain("valet-artifact:theme");
  });
});
