import { useState } from "react";
import type { SecurityFindingsFilters } from "~/api/security";
import { downloadSecurityExport, type SecurityExportFormat } from "~/api/security";
import { Button, Dialog, DialogContent, DialogFooter } from "~/components/primitives";
import { cn } from "~/lib/cn";

/**
 * Export dialog (valet-security design §Export): format (Markdown report |
 * SARIF 2.1.0 | JSON), scope (current filter | all findings), download via
 * authenticated fetch → Blob → object-URL click. A failure renders inline
 * and names itself — never a bare `<a href>` that navigates to raw JSON on
 * a 4xx. The path filter never reaches the export: the route does not
 * accept it, and a scope the server silently narrows would lie about what
 * was exported — the dialog says so when a path filter is active.
 */

const FORMATS: ReadonlyArray<{ value: SecurityExportFormat; label: string }> = [
  { value: "md", label: "Markdown report" },
  { value: "sarif", label: "SARIF 2.1.0" },
  { value: "json", label: "JSON" },
];

export function ExportDialog({
  sessionId,
  open,
  onOpenChange,
  currentFilters,
  filterActive,
}: {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The findings surface's active filters — the "current filter" scope. */
  currentFilters: SecurityFindingsFilters;
  filterActive: boolean;
}) {
  const [format, setFormat] = useState<SecurityExportFormat>("md");
  const [scope, setScope] = useState<"filtered" | "all">("filtered");
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  async function download() {
    setError(null);
    setDownloading(true);
    try {
      const filters = scope === "filtered" ? currentFilters : {};
      await downloadSecurityExport(sessionId, format, filters);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Export findings" description="Generated from rows, view-gated, audit-logged.">
        <div className="space-y-3 text-xs">
          <RadioRow
            legend="Format"
            name="export-format"
            options={FORMATS}
            value={format}
            onChange={setFormat}
          />
          <RadioRow
            legend="Scope"
            name="export-scope"
            options={[
              { value: "filtered", label: "Current filter" },
              { value: "all", label: "All findings" },
            ]}
            value={scope}
            onChange={setScope}
          />
          {scope === "filtered" && filterActive && currentFilters.path !== undefined && (
            <p className="text-muted">
              The path filter does not apply to exports; the other filters do.
            </p>
          )}
          {error && <p className="text-danger-600">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={downloading} onClick={() => void download()}>
            {downloading ? "Exporting…" : "Download"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RadioRow<T extends string>({
  legend,
  name,
  options,
  value,
  onChange,
}: {
  legend: string;
  name: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset>
      <legend className="text-muted mb-1">{legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 cursor-pointer",
              value === option.value
                ? "border-accent-500 bg-accent-100/50 text-ink dark:bg-accent-900/40"
                : "border-line text-muted hover:text-ink",
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
