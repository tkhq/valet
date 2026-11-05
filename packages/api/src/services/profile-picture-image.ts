import type sharpType from "sharp";
import { PROFILE_PICTURE_MAX_BYTES, PROFILE_PICTURE_MAX_DIMENSION, PROFILE_PICTURE_OUTPUT_MAX_DIMENSION } from "../wire/types.js";

declare global {
  var __VALET_SHARP__: typeof sharpType | undefined;
}

const FORMATS = new Map([["image/jpeg", "jpeg"], ["image/png", "png"], ["image/webp", "webp"]]);
type ImageResult = { data: Uint8Array } | { error: string; status: 400 | 413 | 415 };

/** Decode and rewrite the image to strip metadata and bound the public copy. */
export async function normalizeProfilePicture(input: Uint8Array, mimeType: string): Promise<ImageResult> {
  if (input.byteLength === 0) return { error: "The image is empty. Choose a valid image.", status: 400 };
  if (input.byteLength > PROFILE_PICTURE_MAX_BYTES) {
    return { error: `Profile pictures are limited to ${PROFILE_PICTURE_MAX_BYTES / (1024 * 1024)} MB. Choose a smaller image.`, status: 413 };
  }
  const expectedFormat = FORMATS.get(mimeType);
  if (!expectedFormat) return { error: "Use a JPEG, PNG, or WebP image.", status: 415 };
  try {
    const sharp = globalThis.__VALET_SHARP__ ?? (await import("sharp")).default;
    const image = sharp(input, { failOn: "error", limitInputPixels: PROFILE_PICTURE_MAX_DIMENSION * PROFILE_PICTURE_MAX_DIMENSION, animated: false });
    const metadata = await image.metadata();
    if (metadata.format !== expectedFormat) {
      return { error: "The file content does not match its image type. Choose a valid image.", status: 415 };
    }
    if (!metadata.width || !metadata.height || metadata.width > PROFILE_PICTURE_MAX_DIMENSION || metadata.height > PROFILE_PICTURE_MAX_DIMENSION || (metadata.pages ?? 1) !== 1) {
      return { error: `Profile pictures must be one image no larger than ${PROFILE_PICTURE_MAX_DIMENSION} × ${PROFILE_PICTURE_MAX_DIMENSION} pixels.`, status: 400 };
    }
    return { data: new Uint8Array(await image.rotate().resize({ width: PROFILE_PICTURE_OUTPUT_MAX_DIMENSION, height: PROFILE_PICTURE_OUTPUT_MAX_DIMENSION, fit: "inside", withoutEnlargement: true }).webp({ quality: 88 }).toBuffer()) };
  } catch {
    return { error: "The image is malformed or too large to decode. Choose a valid image.", status: 400 };
  }
}
