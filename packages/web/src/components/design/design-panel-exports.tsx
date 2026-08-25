/**
 * The Export modal's "Exported files" section. Always rendered — the empty
 * and cold states carry instructions, and hiding the section at exactly the
 * moment the agent says "grab it from the Export menu" was a dead end.
 *
 * Downloads go through `onDownload` (a fetch-based handler in the page),
 * never a bare `<a href>` — a 4xx behind a link navigates the tab to raw
 * JSON with no road back.
 */
import type { DesignExportFile } from "@valet/api/wire";
import { formatBytes } from "~/lib/format-bytes";
import { cn } from "~/lib/cn";

/** Mirror of `DesignExportsResponse["sandbox"]`, with the missing-field
 * default ("live") already applied by the caller. */
export type ExportSandboxState = "live" | "cold" | "none";

export function DesignPanelExports({
  files,
  sandbox,
  loading,
  downloadingName,
  onDownload,
}: {
  files: DesignExportFile[];
  sandbox: ExportSandboxState;
  /** First fetch in flight — show a quiet placeholder, not "no files". */
  loading?: boolean;
  /** Name of the file a download is running for, or null. */
  downloadingName: string | null;
  onDownload: (file: DesignExportFile) => void;
}) {
  return (
    <div className="mt-3 border-t border-line pt-3">
      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
        Exported files
      </p>
      {loading ? (
        <p className="text-xs text-muted">Loading the export list…</p>
      ) : sandbox === "none" ? (
        <p className="text-xs text-muted">
          Exports appear here after the agent runs an export.
        </p>
      ) : (
        <>
          {files.length === 0 && sandbox === "live" && (
            <p className="text-xs text-muted">No exported files yet.</p>
          )}
          {files.length > 0 && (
            <ul className="space-y-1">
              {files.map((f) => (
                <li key={f.name} className="flex items-center justify-between gap-3 text-sm">
                  <span
                    className={cn(
                      "min-w-0 truncate",
                      sandbox === "cold" ? "text-muted" : "text-ink",
                    )}
                  >
                    {f.name}
                  </span>
                  <button
                    type="button"
                    disabled={sandbox === "cold" || downloadingName === f.name}
                    onClick={() => onDownload(f)}
                    className="shrink-0 text-xs font-medium text-moss hover:underline disabled:cursor-not-allowed disabled:text-muted disabled:no-underline"
                  >
                    {downloadingName === f.name
                      ? "Downloading…"
                      : `Download (${formatBytes(f.size)})`}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {sandbox === "cold" && (
            <p className={cn("text-xs text-muted", files.length > 0 && "mt-1.5")}>
              The session is idle. Send it a message to reconnect, then download.
            </p>
          )}
        </>
      )}
    </div>
  );
}
