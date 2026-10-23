/** Image types the model providers accept. */
export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/**
 * Return the image type that the leading bytes show, or undefined if the bytes are not a supported image.
 * The signature identifies the format only. It does not prove the file is valid or complete.
 */
export function sniffImageMediaType(b: Uint8Array): ImageMediaType | undefined {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return undefined;
}

/**
 * Fix the media type of every image block in provider messages. The bytes win
 * over the declared type. A block with unsupported bytes becomes a text
 * placeholder, so one bad image does not fail every later turn.
 */
export function correctImageBlocks<T>(messages: T[]): T[] {
  return messages.map((m) => {
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content) || !content.some((c) => c?.type === "image")) return m;
    return { ...m, content: content.map(correctBlock) };
  });
}

function correctBlock(block: unknown): unknown {
  const img = block as { type?: string; data?: unknown; mimeType?: string };
  if (img?.type !== "image" || typeof img.data !== "string") return block;
  // 24 base64 chars decode to 18 bytes, enough for every signature.
  const sniffed = sniffImageMediaType(Buffer.from(img.data.slice(0, 24), "base64"));
  if (!sniffed) return { type: "text", text: `[image omitted: ${img.mimeType ?? "unknown type"} data is not a supported image]` };
  return sniffed === img.mimeType ? block : { ...img, mimeType: sniffed };
}
