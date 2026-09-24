import { parseBrowserAgentCursor, type BrowserAgentCursor } from "@valet/shared";
import { createHash } from "node:crypto";

/** Validate inline preview bytes before serving them to the authenticated viewer. */
export function decodeBrowserFrame(value: unknown, tabId: string): {
  data: Buffer;
  agentCursor?: BrowserAgentCursor;
  documentId: string;
  viewport: { width: number; height: number };
} {
  const invalid = () => new Error(
    "The browser frame is invalid. Retry the viewer or update the sandbox image.",
  );
  if (!value || typeof value !== "object") throw invalid();
  const frame = value as Record<string, unknown>;
  if (frame.tabId !== tabId || frame.mimeType !== "image/jpeg" ||
    typeof frame.documentId !== "string" || !frame.documentId || frame.documentId.length > 256 ||
    typeof frame.data !== "string" || frame.data.length > 933_336 ||
    typeof frame.bytes !== "number" || !Number.isInteger(frame.bytes) || frame.bytes < 4 || frame.bytes > 700_000 ||
    typeof frame.sha256 !== "string" || !frame.viewport || typeof frame.viewport !== "object") throw invalid();
  const viewport = frame.viewport as Record<string, unknown>;
  if (typeof viewport.width !== "number" || !Number.isInteger(viewport.width) || viewport.width < 1 || viewport.width > 16384 ||
    typeof viewport.height !== "number" || !Number.isInteger(viewport.height) || viewport.height < 1 || viewport.height > 16384) throw invalid();
  const data = Buffer.from(frame.data, "base64");
  if (data.length !== frame.bytes || data.toString("base64") !== frame.data ||
    data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff ||
    data.at(-2) !== 0xff || data.at(-1) !== 0xd9 ||
    createHash("sha256").update(data).digest("hex") !== frame.sha256) throw invalid();
  return { data, agentCursor: parseBrowserAgentCursor(frame.agentCursor, { width: viewport.width, height: viewport.height }), documentId: frame.documentId, viewport: {width: viewport.width, height: viewport.height} };
}
