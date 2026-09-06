// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { renderMermaid } from "./mermaid";

describe("Mermaid browser rendering", () => {
  beforeAll(() => {
    Object.defineProperty(SVGElement.prototype, "getComputedTextLength", {
      configurable: true,
      value: () => 80,
    });
  });
  it("renders a valid flowchart to filtered SVG", async () => {
    const svg = await renderMermaid("graph TD\n  A-->B", "integration-flow", "default");
    expect(svg).toContain("<svg");
    expect(svg).toContain("flowchart");
  });

  it("does not preserve executable label markup", async () => {
    const svg = await renderMermaid(
      'graph TD\n  A["<script>alert(1)</script>"]',
      "integration-unsafe",
      "default",
    );
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("onclick=");
  });
});
