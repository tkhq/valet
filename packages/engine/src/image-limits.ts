import type sharpType from "sharp";
import { imageDecoder } from "./image-output.js";
import type { MessageEntry } from "./types.js";

/**
 * Image size limits for model input. See
 * `docs/specs/2026-11-11-model-image-limits-design.md`.
 *
 * Anthropic rejects an image with a side over 8000 px, and over 2000 px when
 * one request has more than 20 images. It resizes any image whose long side
 * is over 1568 px (https://docs.claude.com/en/docs/build-with-claude/vision).
 * A thread resends every earlier image on each turn, so 20 images is a normal
 * count. Valet therefore keeps the long side at 2000 px.
 */
export const MODEL_IMAGE_MAX_EDGE = 2000;
/**
 * OpenAI covers an image with 32 x 32 px patches and rejects an image that
 * needs more than 30,000 patches after its own resize rules
 * (https://developers.openai.com/api/docs/guides/images-vision). 2.56 MP is
 * 2,500 patches, far below that limit. Anthropic resizes images above about
 * 1.15 MP, so more pixels add upload bytes but no detail.
 */
export const MODEL_IMAGE_MAX_PIXELS = 2_560_000;

/** Hard provider limits. An image above one of these always fails the request. */
const PROVIDER_MAX_EDGE = 8000;
const PROVIDER_MAX_PATCHES = 30_000;
const PATCH_PX = 32;

/**
 * The largest image the downscale decodes. The failing paste in the report
 * was about 88 MP (86,450 patches). sharp reads PNG and JPEG row by row for a
 * resize, so this bounds time more than memory.
 */
const MAX_DECODE_PIXELS = 150_000_000;

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Read width and height from the image header without a decode. Supports
 * PNG, GIF, JPEG, and WebP. Returns undefined when the header is not in
 * `bytes` (a JPEG frame header can follow large metadata) or the format is
 * unknown. The values are what the file declares, before EXIF rotation.
 */
export function imageDimensions(b: Uint8Array): ImageDimensions | undefined {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  const u16be = (i: number) => (b[i] << 8) | b[i + 1];
  const u16le = (i: number) => b[i] | (b[i + 1] << 8);
  const u24le = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const u32be = (i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
  const valid = (d: ImageDimensions) => (d.width > 0 && d.height > 0 ? d : undefined);
  if (at(0, 0x89, 0x50, 0x4e, 0x47) && b.length >= 24) return valid({ width: u32be(16), height: u32be(20) });
  if (at(0, 0x47, 0x49, 0x46, 0x38) && b.length >= 10) return valid({ width: u16le(6), height: u16le(8) });
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50) && b.length >= 30) {
    if (at(12, 0x56, 0x50, 0x38, 0x20)) return valid({ width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff });
    if (at(12, 0x56, 0x50, 0x38, 0x4c)) {
      const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
      return valid({ width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 });
    }
    if (at(12, 0x56, 0x50, 0x38, 0x58)) return valid({ width: u24le(24) + 1, height: u24le(27) + 1 });
    return undefined;
  }
  if (at(0, 0xff, 0xd8)) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
      // SOF0..SOF15 carry the frame size. C4 (DHT), C8 (JPG), and CC (DAC) do not.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return valid({ width: u16be(i + 7), height: u16be(i + 5) });
      }
      i += 2 + u16be(i + 2);
    }
  }
  return undefined;
}

/** Whether every provider rejects an image of this size, whatever the model. */
export function exceedsProviderImageLimits({ width, height }: ImageDimensions): boolean {
  const patches = Math.ceil(width / PATCH_PX) * Math.ceil(height / PATCH_PX);
  return Math.max(width, height) > PROVIDER_MAX_EDGE || patches > PROVIDER_MAX_PATCHES;
}

function needsDownscale({ width, height }: ImageDimensions): boolean {
  return Math.max(width, height) > MODEL_IMAGE_MAX_EDGE || width * height > MODEL_IMAGE_MAX_PIXELS;
}

/** The size that fits both model limits and keeps the aspect ratio. */
export function modelImageSize({ width, height }: ImageDimensions): ImageDimensions {
  const scale = Math.min(1, MODEL_IMAGE_MAX_EDGE / Math.max(width, height), Math.sqrt(MODEL_IMAGE_MAX_PIXELS / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

/**
 * Downscale an image that is over a model limit. Returns undefined when the
 * image already fits or the decoder cannot read it. JPEG and WebP keep their
 * format. PNG, GIF (first frame), and other formats become PNG.
 */
export async function fitImageForModels(
  bytes: Uint8Array,
  sharp: typeof sharpType,
): Promise<{ bytes: Uint8Array; mimeType: string } | undefined> {
  const declared = imageDimensions(bytes);
  if (declared && !needsDownscale(declared)) return undefined;
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_DECODE_PIXELS, failOn: "none", animated: false });
    const meta = await image.metadata();
    if (!meta.width || !meta.height) return undefined;
    // EXIF orientations 5-8 turn the image on its side.
    const rotated = (meta.orientation ?? 1) >= 5;
    const size = rotated ? { width: meta.height, height: meta.width } : { width: meta.width, height: meta.height };
    if (!needsDownscale(size)) return undefined;
    const target = modelImageSize(size);
    // Set only the long side. sharp derives the other side from the aspect ratio.
    const resized = image.rotate().resize(size.width >= size.height ? { width: target.width } : { height: target.height });
    const out = meta.format === "jpeg" ? resized.jpeg({ quality: 85 })
      : meta.format === "webp" ? resized.webp({ quality: 85 })
      : resized.png();
    const mimeType = meta.format === "jpeg" ? "image/jpeg" : meta.format === "webp" ? "image/webp" : "image/png";
    return { bytes: new Uint8Array(await out.toBuffer()), mimeType };
  } catch (err) {
    console.warn(`[engine] cannot downscale an image attachment: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

type Attachments = NonNullable<MessageEntry["attachments"]>;
const RASTER_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Downscale the image attachments of a new user message before Valet stores
 * it, so every later turn resends the small copy. Web, channel, and API
 * messages all pass through here. An attachment that cannot be read stays as
 * it is; `correctImageBlocks` then guards each request.
 */
export async function fitImageAttachments(
  attachments: MessageEntry["attachments"],
  loadDecoder: () => Promise<typeof sharpType> = imageDecoder,
): Promise<MessageEntry["attachments"]> {
  if (!attachments?.some((att) => att.type === "image" && RASTER_TYPES.has(att.mimeType))) return attachments;
  let sharp: typeof sharpType | undefined;
  const out: Attachments = [];
  for (const att of attachments) {
    if (att.type !== "image" || !RASTER_TYPES.has(att.mimeType)) { out.push(att); continue; }
    const match = att.data ? undefined : att.url?.match(/^data:[^;]+;base64,([A-Za-z0-9+/]+=*)$/);
    const bytes = att.data ?? (match ? new Uint8Array(Buffer.from(match[1], "base64")) : undefined);
    if (!bytes) { out.push(att); continue; }
    const declared = imageDimensions(bytes);
    if (declared && !needsDownscale(declared)) { out.push(att); continue; }
    try {
      sharp ??= await loadDecoder();
    } catch (err) {
      console.warn(`[engine] image decoder unavailable, sending the original image: ${err instanceof Error ? err.message : String(err)}`);
      return attachments;
    }
    const fitted = await fitImageForModels(bytes, sharp);
    if (!fitted) { out.push(att); continue; }
    out.push(att.data
      ? { ...att, data: fitted.bytes, mimeType: fitted.mimeType }
      : { ...att, url: `data:${fitted.mimeType};base64,${Buffer.from(fitted.bytes).toString("base64")}`, mimeType: fitted.mimeType });
  }
  return out;
}

/**
 * Whether a provider error says it rejected an image in the request. Matches
 * OpenAI ("requires N patches", "Invalid image"), Anthropic ("image
 * dimensions exceed", "Could not process image", "image exceeds 5 MB"), and
 * Gemini ("Unable to process input image") wording.
 */
export function isImageRejection(errorMessage: string | undefined): boolean {
  if (!errorMessage || !/image/i.test(errorMessage)) return false;
  return /patches|dimensions? exceed|image exceeds|exceeds? the maximum|could not process image|unable to process (input )?image|invalid image|image_parse_error|image (is )?too large/i.test(errorMessage);
}

/** Text that stands in for the images a provider rejected. */
export const REJECTED_IMAGE_TEXT =
  "[image omitted: the model provider rejected an image in this conversation, so Valet removed the images sent up to that point. If you need an image, ask the user to send a smaller copy.]";

/** Replace every image block with `REJECTED_IMAGE_TEXT`. Returns the input when it has no image. */
export function withoutImageBlocks<T>(messages: T[]): T[] {
  let changed = false;
  const out = messages.map((m) => {
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content) || !content.some((c) => c?.type === "image")) return m;
    changed = true;
    return { ...m, content: content.map((c) => (c?.type === "image" ? { type: "text", text: REJECTED_IMAGE_TEXT } : c)) };
  });
  return changed ? out : messages;
}

/** User-entry metadata: a provider rejected an image in this entry's turn. */
export const IMAGE_REJECTED_KEY = "imageRejectedByProvider";
