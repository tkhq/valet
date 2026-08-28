import { useState } from "react";
import type { SecurityReportWire } from "@valet/api/wire";
import {
  downloadSecurityReport,
  type SecurityReportFormat,
} from "~/api/security";
import { Markdown } from "~/components/markdown";
import { Button } from "~/components/primitives";

/**
 * The report section (M-P3, spec §Report generation): renders the report
 * cell's markdown artifact and offers a .md and a .json download. Three states:
 *   - a stored report → the markdown plus the two download buttons,
 *   - `generating` (the engagement runs a report cell) → a "generating…" note,
 *   - otherwise → a "not yet generated" note.
 *
 * The download is the authenticated fetch → Blob path (never a bare `<a href>`
 * to the export route, which a 4xx would navigate the tab to). A failure
 * renders inline and names itself.
 */
export function ReportSection({
  sessionId,
  report,
  generating,
}: {
  sessionId: string;
  /** The report artifact, or null before the report cell writes one. */
  report: SecurityReportWire | null;
  /** True while a report cell is running — the report is on its way. */
  generating: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<SecurityReportFormat | null>(null);

  async function download(format: SecurityReportFormat) {
    setError(null);
    setDownloading(format);
    try {
      await downloadSecurityReport(sessionId, format);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(null);
    }
  }

  return (
    <section className="border-b border-line px-4 py-3" aria-label="Report">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-semibold text-ink">Report</span>
        {report && (
          <span className="text-muted tabular-nums">
            generated {new Date(report.generatedAt).toLocaleString()}
          </span>
        )}
      </div>

      {!report && generating && (
        <p className="mt-2 text-[11px] text-muted" aria-live="polite">
          Generating the report…
        </p>
      )}
      {!report && !generating && (
        <p className="mt-2 text-[11px] text-muted">
          The report is not yet generated. It is written by the report cell at the end of the
          engagement.
        </p>
      )}

      {report && (
        <>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              disabled={downloading !== null}
              onClick={() => void download("md")}
            >
              {downloading === "md" ? "Downloading…" : "Download .md"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={downloading !== null}
              onClick={() => void download("json")}
            >
              {downloading === "json" ? "Downloading…" : "Download .json"}
            </Button>
          </div>
          {error && <p className="mt-2 text-[11px] text-danger-600">{error}</p>}
          <div className="mt-3 max-h-96 overflow-y-auto rounded border border-line bg-paper px-3 py-2">
            <Markdown>{report.markdown}</Markdown>
          </div>
        </>
      )}
    </section>
  );
}
