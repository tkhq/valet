import { useRef, useState, type ChangeEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, Upload, X } from "lucide-react";
import { api } from "~/api/client";
import { qkMemory } from "~/api/memory";
import type { ImportMemoryResponse } from "~/api/memory-types";
import { Button, Spinner } from "~/components/primitives";

/** Parsed, validated bundle — what the confirm step shows and the import
 * request sends. */
export interface ParsedBundle {
  files: Record<string, string | { content: string }>;
  fileCount: number;
  /** "v1" | "v2" when the bundle carries a `source` field; null for a bare
   * `{ path → content }` map or a foreign bundle. */
  source: string | null;
}

/**
 * Pure: bundle file text → files map. Accepts three shapes:
 * 1. A Valet bundle: `{ files: { path → content | {content} }, source? }`
 *    (the V1 export route and the V2 export download both emit this).
 * 2. The raw V2 export response: `{ files: { path → {content, hash} } }`.
 * 3. A bare `{ path → content }` map (hand-rolled bundles).
 * Throws with a user-facing message when the shape is none of these.
 */
export function parseBundle(text: string): ParsedBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Not a JSON file. Choose a Valet memory bundle (.json).");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Bundle must be a JSON object with a `files` map.");
  }
  const obj = raw as Record<string, unknown>;
  const filesRaw = "files" in obj ? obj.files : obj;
  if (filesRaw === null || typeof filesRaw !== "object" || Array.isArray(filesRaw)) {
    throw new Error("Bundle must be a JSON object with a `files` map.");
  }

  // Null-prototype accumulator: bundle keys are untrusted, and a literal
  // "__proto__" key assigned onto `{}` mutates Object.prototype for the
  // whole page. With no prototype there is no setter to hit.
  const files: Record<string, string | { content: string }> = Object.create(null) as Record<
    string,
    string | { content: string }
  >;
  for (const [path, value] of Object.entries(filesRaw as Record<string, unknown>)) {
    if (typeof value === "string") {
      files[path] = value;
    } else if (
      value !== null &&
      typeof value === "object" &&
      typeof (value as Record<string, unknown>).content === "string"
    ) {
      files[path] = { content: (value as { content: string }).content };
    } else {
      throw new Error(`Entry '${path}' is not text. Each file must be a string or { content }.`);
    }
  }
  if (Object.keys(files).length === 0) {
    throw new Error("Bundle contains no files.");
  }

  return {
    files,
    fileCount: Object.keys(files).length,
    source: typeof obj.source === "string" ? obj.source : null,
  };
}

/** Pure: import result → one status line. */
export function summarizeImport(r: ImportMemoryResponse): string {
  const parts = [`Imported ${r.imported.length}`];
  if (r.skipped.length > 0) parts.push(`skipped ${r.skipped.length}`);
  if (r.remapped.length > 0) parts.push(`remapped ${r.remapped.length}`);
  return parts.join(" · ");
}

/** Refuse bundles bigger than this before reading them. */
export const MAX_BUNDLE_BYTES = 15 * 1024 * 1024;

type Phase =
  | { kind: "idle" }
  | { kind: "confirm"; bundle: ParsedBundle; fileName: string }
  | { kind: "busy"; label: string }
  | { kind: "done"; result: ImportMemoryResponse }
  | { kind: "error"; message: string };

/**
 * Footer bar of the memory explorer's left pane: Export downloads the OKF
 * bundle as JSON; Import takes a bundle file (V1 export, V2 export, or a
 * bare path→content map), shows a confirm step with a trust toggle, then
 * posts it and reports imported/skipped/remapped counts. This is the whole
 * V1→V2 migration path: export from V1's `/api/me/memory/export`, import
 * here.
 */
export function MemoryImportExport() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [trusted, setTrusted] = useState(false);

  async function onExport() {
    setPhase({ kind: "busy", label: "Exporting…" });
    try {
      const res = await api.exportMemory();
      const bundle = {
        format: "valet-memory-bundle@1",
        source: "v2",
        exportedAt: new Date().toISOString(),
        fileCount: Object.keys(res.files).length,
        files: res.files,
      };
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `valet-memory-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setPhase({ kind: "idle" });
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof Error ? err.message : "Export failed." });
    }
  }

  function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    if (file.size > MAX_BUNDLE_BYTES) {
      // JSON.parse of a multi-10MB string freezes the main thread.
      setPhase({
        kind: "error",
        message: `Bundle is ${Math.round(file.size / 1024 / 1024)} MB; the limit is ${MAX_BUNDLE_BYTES / 1024 / 1024} MB. Split it and import in parts.`,
      });
      return;
    }
    void file.text().then(
      (text) => {
        try {
          const bundle = parseBundle(text);
          // A bundle from your own Valet export carries sensitivity/origin
          // metadata worth keeping; a foreign map defaults to untrusted.
          setTrusted(bundle.source === "v1" || bundle.source === "v2");
          setPhase({ kind: "confirm", bundle, fileName: file.name });
        } catch (err) {
          setPhase({ kind: "error", message: err instanceof Error ? err.message : "Unreadable bundle." });
        }
      },
      () => setPhase({ kind: "error", message: "Could not read the file." }),
    );
  }

  async function onConfirmImport(bundle: ParsedBundle) {
    setPhase({ kind: "busy", label: "Importing…" });
    try {
      const result = await api.importMemory({ files: bundle.files, trusted });
      await queryClient.invalidateQueries({ queryKey: qkMemory.tree() });
      setPhase({ kind: "done", result });
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof Error ? err.message : "Import failed." });
    }
  }

  return (
    <div className="border-t border-line px-2 py-2 text-xs">
      {phase.kind === "confirm" ? (
        <div className="space-y-2 px-1">
          <p className="text-ink">
            Import <span className="font-medium">{phase.bundle.fileCount}</span> file
            {phase.bundle.fileCount === 1 ? "" : "s"} from{" "}
            <span className="font-medium">{phase.fileName}</span>
            {phase.bundle.source ? ` (${phase.bundle.source} export)` : ""}?
          </p>
          <label className="flex items-center gap-1.5 text-muted">
            <input
              type="checkbox"
              checked={trusted}
              onChange={(e) => setTrusted(e.target.checked)}
              className="accent-[--moss]"
            />
            Trust bundle metadata (sensitivity, origin)
          </label>
          <div className="flex gap-1.5">
            <Button size="sm" onClick={() => void onConfirmImport(phase.bundle)}>
              Import
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPhase({ kind: "idle" })}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void onExport()}
            disabled={phase.kind === "busy"}
          >
            <Download className="h-3.5 w-3.5" /> Export
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => fileInputRef.current?.click()}
            disabled={phase.kind === "busy"}
          >
            <Upload className="h-3.5 w-3.5" /> Import
          </Button>
          {phase.kind === "busy" && (
            <span className="flex items-center gap-1.5 text-muted">
              <Spinner size={12} /> {phase.label}
            </span>
          )}
        </div>
      )}

      {phase.kind === "done" && (
        <div className="space-y-1 px-1 pt-1.5">
          <p className="flex items-center gap-1.5 text-moss">
            {summarizeImport(phase.result)}
            <button
              type="button"
              onClick={() => setPhase({ kind: "idle" })}
              aria-label="Dismiss import result"
              className="ml-auto text-muted hover:text-ink"
            >
              <X className="h-3 w-3" />
            </button>
          </p>
          {phase.result.skipped.slice(0, 3).map((s) => (
            <p key={s.path} className="text-muted truncate" title={`${s.path}: ${s.reason}`}>
              {s.path}: {s.reason}
            </p>
          ))}
          {phase.result.skipped.length > 3 && (
            <p className="text-muted">…and {phase.result.skipped.length - 3} more skipped.</p>
          )}
        </div>
      )}
      {phase.kind === "error" && (
        <p className="flex items-center gap-1.5 px-1 pt-1.5 text-danger-500">
          {phase.message}
          <button
            type="button"
            onClick={() => setPhase({ kind: "idle" })}
            aria-label="Dismiss error"
            className="ml-auto text-muted hover:text-ink"
          >
            <X className="h-3 w-3" />
          </button>
        </p>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={onPickFile}
      />
    </div>
  );
}
