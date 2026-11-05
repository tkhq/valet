import { Download } from "lucide-react";
import { ImagePreview } from "./image-preview";
import { ToolBody } from "./tool-shell";
import { resultText, structuredResult, type ToolRenderer } from "./types";

/** Image types the chat shows inline (services/generated-files.ts INLINE_IMAGE_TYPES). */
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]);
const IMAGE_PATH = /\.(png|jpe?g|gif|webp|svg)$/i;

export interface FileDownload {
  name: string;
  url: string;
  /** Set when the file is an image the chat shows inline. */
  image?: { alt: string; title?: string };
}

export function parseFileDownload(result: unknown, origin = window.location.origin): FileDownload | null {
  const value = structuredResult(result);
  if (!value || typeof value !== "object" || !("name" in value) || !("url" in value)) return null;
  if (typeof value.name !== "string" || !value.name || typeof value.url !== "string") return null;
  const href = "webUrl" in value && typeof value.webUrl === "string" ? value.webUrl : value.url;
  // Only this app's authenticated download endpoint can become a clickable result.
  if (!href.startsWith("/api/") && !/^https?:\/\//.test(href)) return null;
  let url: URL;
  try { url = new URL(href, origin); } catch { return null; }
  if (url.origin !== origin || url.username || url.password || url.search || url.hash || href.startsWith("//")) return null;
  if (!/^\/api\/sessions\/[^/?#]+\/threads\/[^/?#]+\/files\/[a-zA-Z0-9-]+$/.test(url.pathname)) return null;
  const mimeType = "mimeType" in value && typeof value.mimeType === "string" ? value.mimeType : "";
  if (!INLINE_IMAGE_TYPES.has(mimeType)) return { name: value.name, url: href };
  const alt = "alt" in value && typeof value.alt === "string" && value.alt ? value.alt : value.name;
  const title = "title" in value && typeof value.title === "string" && value.title ? value.title : undefined;
  return { name: value.name, url: href, image: { alt, ...(title ? { title } : {}) } };
}

function argString(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value: unknown = Reflect.get(args, key);
  return typeof value === "string" && value ? value : undefined;
}

/** `file_attach` and `render_diagram` save the same thread file; an image result shows inline. */
export const fileAttachRenderer: ToolRenderer = {
  matches: ["file_attach", "render_diagram"],
  category: "write",
  Icon: Download,
  formatTarget: (args, toolName) => toolName === "render_diagram" ? argString(args, "title") ?? "diagram" : argString(args, "path"),
  formatSummary: (_args, result, status) => {
    const file = status === "completed" ? parseFileDownload(result) : null;
    return file ? (file.image ? "image" : "download ready") : undefined;
  },
  keepsInView: (args, toolName) => toolName === "render_diagram" || IMAGE_PATH.test(argString(args, "path") ?? ""),
  Preview: ({ result, status, error }) => {
    const file = status === "completed" && !error ? parseFileDownload(result) : null;
    if (!file?.image) return null;
    return <ImagePreview src={file.url} alt={file.image.alt} title={file.image.title} download={{ href: file.url, name: file.name }} />;
  },
  Body: ({ result, status, error, toolName }) => {
    const file = status === "completed" ? parseFileDownload(result) : null;
    const pending = toolName === "render_diagram" ? "Rendering diagram…" : "Preparing download…";
    if (file?.image) return <ToolBody><p className="break-all font-mono text-xs text-muted">{file.name}</p></ToolBody>;
    return (
      <ToolBody>
        {file ? (
          <a href={file.url} download={file.name} className="inline-flex min-h-11 max-w-full items-center gap-2 text-sm text-moss hover:underline">
            <Download className="h-4 w-4 shrink-0" aria-hidden />
            <span className="min-w-0 break-all">Download {file.name}</span>
          </a>
        ) : (
          <p className="break-words text-sm text-muted">{error || resultText(result) || (status === "running" ? pending : "No downloadable file returned.")}</p>
        )}
      </ToolBody>
    );
  },
};
