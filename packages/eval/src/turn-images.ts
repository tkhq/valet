import { imageDecoder } from "@valet/engine";
import type { EvalTurnImage } from "./types.js";

/** One image attachment in the shape both drives send: engine `PromptContent` and the api messages route. */
export interface TurnImageAttachment {
  type: "image";
  url: string;
  mimeType: "image/png";
  name: string;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Render a turn's images as PNG data URLs. A case states each image as a
 * size and text lines, so the case file holds the expected content and no
 * binary fixture is committed.
 */
export async function renderTurnImages(images: readonly EvalTurnImage[]): Promise<TurnImageAttachment[]> {
  if (images.length === 0) return [];
  const sharp = await imageDecoder();
  const out: TurnImageAttachment[] = [];
  for (const image of images) {
    const lines = image.texts.map((t) =>
      `<text x="${t.x ?? 40}" y="${t.y}" font-size="${t.size}" font-family="Arial, Helvetica, sans-serif" fill="${escapeXml(t.color ?? "#111111")}">${escapeXml(t.text)}</text>`);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${image.width}" height="${image.height}">` +
      `<rect width="100%" height="100%" fill="${escapeXml(image.background ?? "#ffffff")}"/>${lines.join("")}</svg>`;
    const png = await sharp(Buffer.from(svg), { limitInputPixels: false }).png().toBuffer();
    out.push({ type: "image", url: `data:image/png;base64,${png.toString("base64")}`, mimeType: "image/png", name: image.name });
  }
  return out;
}
