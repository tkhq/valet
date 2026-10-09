import type sharpType from "sharp";

declare global {
  var __VALET_SHARP__: typeof sharpType | undefined;
}

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = Math.floor((5 * 1024 * 1024 - 128) / 4) * 3;
const MAX_IMAGE_PIXELS = 4096 * 4096;
export const IMAGE_FORMATS = { png: { mime: "image/png", ext: "png" }, jpeg: { mime: "image/jpeg", ext: "jpg" }, webp: { mime: "image/webp", ext: "webp" } };

export async function imageDecoder(): Promise<typeof sharpType> {
  try {
    return globalThis.__VALET_SHARP__ ?? (await import("sharp")).default;
  } catch {
    throw new Error("The image decoder cannot load. Reinstall Valet or rebuild its native assets before requesting an image.");
  }
}

export async function validateImage(bytes: Uint8Array, sharp: typeof sharpType, expectedFormat?: string): Promise<string> {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error("The image is empty or exceeds 20 MB. Use a smaller image or request a smaller output.");
  }
  try {
    const image = sharp(bytes, { failOn: "warning", limitInputPixels: MAX_IMAGE_PIXELS });
    const metadata = await image.metadata();
    if (!metadata.format || !Object.hasOwn(IMAGE_FORMATS, metadata.format) || (expectedFormat && metadata.format !== expectedFormat) ||
      !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) throw new Error("Invalid image");
    // Decode all pixels, not just the header. Keep the original encoded bytes for the saved file and attachment.
    await image.stats();
    return metadata.format;
  } catch {
    throw new Error("The image is malformed, too large to decode, or has the wrong format. Use a valid PNG, JPEG, or WebP image. If it exceeds 16,777,216 pixels, resize it.");
  }
}

/** Preview edge lengths, largest first. A dense 1024 px image can still exceed the limit, so smaller edges follow. */
const PREVIEW_EDGES = [1024, 768, 512];

/** Keep the original file, but bound the preview replayed to the session model. */
export async function imageAttachment(bytes: Uint8Array, format: "png" | "jpeg" | "webp", sharp: typeof sharpType): Promise<Uint8Array> {
  if (bytes.byteLength <= MAX_ATTACHMENT_BYTES) return bytes;
  for (const edge of PREVIEW_EDGES) {
    const preview = new Uint8Array(await sharp(bytes, { failOn: "warning", limitInputPixels: MAX_IMAGE_PIXELS })
      .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
      .toFormat(format).toBuffer());
    if (preview.length && preview.byteLength <= MAX_ATTACHMENT_BYTES) return preview;
  }
  throw new Error("Cannot create an image preview smaller than 5 MB. Use the saved original file.");
}

export function decodeImageBase64(b64: unknown): Uint8Array {
  if (typeof b64 !== "string" || !b64 || b64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
    b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw new Error("OpenAI returned missing, malformed, or oversized image data. Retry with a smaller output.");
  }
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  if (Buffer.from(bytes).toString("base64") !== b64) throw new Error("OpenAI returned invalid base64 image data. Retry the request.");
  return bytes;
}
