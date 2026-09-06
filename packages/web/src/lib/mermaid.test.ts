// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mermaidMock = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({ default: mermaidMock }));

import { renderMermaid, sanitizeMermaidSvg } from "./mermaid";

describe("renderMermaid", () => {
  beforeEach(() => {
    mermaidMock.initialize.mockReset();
    mermaidMock.render.mockReset();
    mermaidMock.render.mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>',
    });
  });

  it("uses strict settings for untrusted source", async () => {
    await renderMermaid("graph TD; A-->B", "diagram-1", "dark");

    expect(mermaidMock.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        htmlLabels: false,
        secure: expect.arrayContaining(["securityLevel", "htmlLabels", "flowchart"]),
        theme: "dark",
      }),
    );
  });
});

describe("sanitizeMermaidSvg", () => {
  it("removes script, event handlers, foreign HTML, and external links", () => {
    const svg = sanitizeMermaidSvg(`
      <svg xmlns="http://www.w3.org/2000/svg">
        <script>alert(1)</script>
        <foreignObject><div xmlns="http://www.w3.org/1999/xhtml">unsafe</div></foreignObject>
        <a href="javascript:alert(1)" onclick="alert(1)"><text>link</text></a>
        <use href="#safe-marker" />
      </svg>
    `);

    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("foreignObject");
    expect(svg).not.toContain("javascript:");
    expect(svg).not.toContain("onclick");
    expect(svg).toContain('href="#safe-marker"');
  });

  it("rejects a non-SVG result", () => {
    expect(() => sanitizeMermaidSvg("<html></html>")).toThrow("invalid SVG");
  });
});
