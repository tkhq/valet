import { describe, expect, it } from "vitest";
import {
  renderBrowserAnnotation,
  validateAnnotationMarks,
} from "./browser-annotations.js";
import type { BrowserArtifact } from "@valet/shared";
const artifact: BrowserArtifact = {
  id: "image",
  sessionId: "s",
  runtimeId: "r",
  documentId: "d",
  mimeType: "image/png",
  bytes: 1,
  sha256: "hash",
  filename: "shot.png",
  createdAt: 1,
  viewport: {
    width: 100,
    height: 80,
    deviceScaleFactor: 2,
    scrollX: 0,
    scrollY: 0,
  },
};
describe("browser screenshot annotations", () => {
  it("rejects marks outside the captured screenshot and limits labels", () => {
    expect(() =>
      validateAnnotationMarks(artifact, [{ x: 101, y: 0, label: "x" }]),
    ).toThrow("bounds");
    expect(() =>
      validateAnnotationMarks(artifact, [
        { x: 1, y: 1, label: "x".repeat(201) },
      ]),
    ).toThrow("label");
    expect(
      validateAnnotationMarks(artifact, [{ x: 50, y: 40, label: "Button" }]),
    ).toEqual({ width: 100, height: 80 });
  });
  it("escapes label markup and embeds only the original raster bytes", () => {
    const svg = renderBrowserAnnotation(artifact, new Uint8Array([1]), [
      { x: 10, y: 20, label: "<script>alert(1)</script>" },
    ]);
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("data:image/png;base64,AQ==");
    expect(svg).toContain('viewBox="0 0 100 80"');
  });
});
