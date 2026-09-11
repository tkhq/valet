import { encode } from "@toon-format/toon";

/** Encode structured tool output for the model, with JSON as the safe fallback. */
export function encodeToolOutput(data: unknown): string {
  try {
    return encode(data);
  } catch {
    return JSON.stringify(data, null, 2);
  }
}
