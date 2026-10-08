import { Download } from "lucide-react";
import { ToolBody } from "./tool-shell";
import { resultText, structuredResult, type ToolRenderer } from "./types";

export function parseFileDownload(result: unknown): { name: string; url: string } | null {
  const value = structuredResult(result);
  if (!value || typeof value !== "object" || !("name" in value) || !("url" in value)) return null;
  if (typeof value.name !== "string" || !value.name || typeof value.url !== "string") return null;
  // Only the authenticated download endpoint can become a clickable file result.
  if (!/^\/api\/sessions\/[^/?#]+\/threads\/[^/?#]+\/files\/[a-zA-Z0-9-]+$/.test(value.url)) return null;
  return { name: value.name, url: value.url };
}

export const fileAttachRenderer: ToolRenderer = {
  matches: "file_attach",
  category: "write",
  Icon: Download,
  formatTarget: (args) => args && typeof args === "object" && "path" in args && typeof args.path === "string" ? args.path : undefined,
  formatSummary: (_args, result, status) => status === "completed" && parseFileDownload(result) ? "download ready" : undefined,
  Body: ({ result, status, error }) => {
    const file = status === "completed" ? parseFileDownload(result) : null;
    return (
      <ToolBody>
        {file ? (
          <a href={file.url} download={file.name} className="inline-flex min-h-11 max-w-full items-center gap-2 text-sm text-moss hover:underline">
            <Download className="h-4 w-4 shrink-0" aria-hidden />
            <span className="min-w-0 break-all">Download {file.name}</span>
          </a>
        ) : (
          <p className="break-words text-sm text-muted">{error || resultText(result) || (status === "running" ? "Preparing download…" : "No downloadable file returned.")}</p>
        )}
      </ToolBody>
    );
  },
};
