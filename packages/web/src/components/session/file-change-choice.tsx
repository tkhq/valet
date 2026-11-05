import { useState } from "react";
import { Checkbox, textLinkClass } from "~/components/primitives";

/**
 * A yes-or-no choice about file changes, with the files behind a disclosure:
 * "Also undo file changes (3 files)" in the edit bar, "Also bring back the
 * file changes" on a branch note
 * (docs/specs/2026-10-22-thread-edit-fork-design.md).
 */
export function FileChangeChoice({ label, files, checked, onCheckedChange, hint }: {
  label: string;
  files: string[];
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  hint?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <label className="flex cursor-pointer items-center gap-2 max-sm:min-h-11">
          <Checkbox checked={checked} onCheckedChange={onCheckedChange} />
          <span>{label}</span>
        </label>
        <button type="button" className={`${textLinkClass} max-sm:min-h-11`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide files" : "Show files"}
        </button>
      </div>
      {hint && <p className="text-muted">{hint}</p>}
      {open && (
        <ul className="max-h-32 overflow-y-auto rounded border border-line bg-paper px-2 py-1 font-mono text-[11px] [overflow-wrap:anywhere]">
          {files.map((file) => <li key={file}>{file}</li>)}
        </ul>
      )}
    </div>
  );
}
