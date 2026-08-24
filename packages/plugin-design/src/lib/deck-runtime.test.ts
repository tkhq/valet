import { describe, expect, it } from "vitest";
import { injectDeckRuntime, inlineDesignTokens } from "./deck-runtime.js";

const DOC = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>:root { --color-primary: #override; }</style>
</head>
<body>
  <section><h1>One</h1></section>
</body>
</html>`;

describe("inlineDesignTokens", () => {
  it("inserts a :root block at the TOP of <head> so artifact styles win", () => {
    const out = inlineDesignTokens(DOC, { "--color-bg": "#fff", "--color-primary": "#00f" });
    const tokensAt = out.indexOf("data-vd-tokens");
    const artifactStyleAt = out.indexOf("#override");
    expect(tokensAt).toBeGreaterThan(-1);
    // Artifact's own definition comes LATER in source order — it wins the
    // cascade over the injected defaults.
    expect(tokensAt).toBeLessThan(artifactStyleAt);
    expect(out).toContain("--color-bg: #fff;");
  });

  it("ignores non-custom-property keys and no-ops on empty tokens", () => {
    expect(inlineDesignTokens(DOC, {})).toBe(DOC);
    const out = inlineDesignTokens(DOC, { "color-bg": "#fff" });
    expect(out).toBe(DOC);
  });

  it("prepends when the document has no <head>", () => {
    const out = inlineDesignTokens("<body><section>x</section></body>", { "--a": "1" });
    expect(out.startsWith("<style data-vd-tokens>")).toBe(true);
  });
});

describe("injectDeckRuntime", () => {
  it("injects the viewer before </body> with print pagination", () => {
    const out = injectDeckRuntime(DOC);
    expect(out).toContain("vd-deck-runtime");
    expect(out).toContain("@page { size: 1920px 1080px");
    expect(out.indexOf("vd-deck-runtime")).toBeLessThan(out.indexOf("</body>"));
  });

  it("print overrides come AFTER the screen rules and defeat position:fixed", () => {
    // Source-order regression: at equal specificity the LATER rule wins.
    // With the @media print block first, the screen rule left the stage
    // position:fixed in print and every deck collapsed to a ONE-page PDF.
    const out = injectDeckRuntime(DOC);
    const screenStage = out.indexOf(".vd-deck-stage { position: fixed");
    const printBlock = out.indexOf("@media print");
    expect(screenStage).toBeGreaterThan(-1);
    expect(printBlock).toBeGreaterThan(screenStage);
    expect(out).toContain("position: static !important");
  });
});
