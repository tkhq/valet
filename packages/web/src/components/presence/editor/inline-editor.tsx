/**
 * The editor inline on a line's or a routine's page
 * (docs/specs/2026-10-16-presence-hub-design.md Part D step 1.6, Part E
 * step 2): every section of the form (When, Do, Where, Appears as, Name)
 * stays open on the page, so the reader sees and changes the line in one
 * place. A change shows a bar at the bottom of the view with the sentence
 * the change stores, the warnings, and Cancel and Save. Cancel drops the
 * changes. Leaving the page with changes asks first.
 *
 * The form reads the stored row at mount, and the patch diffs against that
 * copy. While the form is clean, a refetched row that reads differently
 * mounts a new form on it; while the reader has changes, the form keeps
 * their copy, so a refresh never drops an edit.
 */
import { useEffect, useId, useState } from "react";
import { useBlocker } from "@tanstack/react-router";
import { ConfirmDialog } from "~/components/primitives";
import { browserTimeZone } from "~/lib/time-zones";
import { Sentence } from "../sentence";
import { draftForMode, draftKey, type EditorMode } from "./draft";
import { EditorFooter, EditorNotices } from "./side-pane";
import { useEditorForm, type EditorSaved } from "./use-editor-form";

/** A stored line or routine, the two modes a page edits. */
export type InlineMode = Extract<EditorMode, { kind: "edit" } | { kind: "edit-routine" }>;

/** What the form reads from the stored row. A refetch that changes it
 * reseeds a clean form. */
function seedKey(mode: InlineMode): string {
  return draftKey(draftForMode(mode, { timezone: browserTimeZone() }));
}

const alwaysBlock = () => true;

export function InlineEditor({ mode, readOnly, onSaved }: {
  mode: InlineMode;
  /** True when the viewer may not change it: the form shows, disabled. */
  readOnly: boolean;
  onSaved?(result: EditorSaved): void;
}) {
  const key = seedKey(mode);
  const [dirty, setDirty] = useState(false);
  const [seed, setSeed] = useState({ mode, key, generation: 0 });
  useEffect(() => {
    if (dirty || key === seed.key) return;
    setSeed((current) => ({ mode, key, generation: current.generation + 1 }));
  }, [key, dirty]);
  // Cancel, and Done after an overlap, start over from the stored row.
  const restart = () => {
    setDirty(false);
    setSeed((current) => ({ mode, key, generation: current.generation + 1 }));
  };
  return (
    <InlineForm
      key={seed.generation}
      mode={seed.mode}
      readOnly={readOnly}
      onDirtyChange={setDirty}
      onRestart={restart}
      {...(onSaved !== undefined ? { onSaved } : {})}
    />
  );
}

function InlineForm({ mode, readOnly, onDirtyChange, onRestart, onSaved }: {
  mode: InlineMode;
  readOnly: boolean;
  onDirtyChange(dirty: boolean): void;
  onRestart(): void;
  onSaved?(result: EditorSaved): void;
}) {
  const headingId = useId();
  const form = useEditorForm(mode, { onSaved, onFinish: onRestart, inline: true });
  const { dirty, sideProps } = form;
  useEffect(() => onDirtyChange(dirty), [dirty]);
  const leave = useBlocker({ shouldBlockFn: alwaysBlock, disabled: !dirty, withResolver: true });
  const showBar = !readOnly && (dirty || form.frozen || sideProps.error !== null || (sideProps.collisions ?? null) !== null);

  return (
    <section aria-labelledby={headingId} data-inline-editor className="space-y-3">
      <h2 id={headingId} className="text-[13px] font-medium text-muted">How it works</h2>
      {form.sections({ isOpen: () => true }, readOnly)}
      {showBar && (
        <div
          role="region"
          aria-label="Unsaved changes"
          className="sticky bottom-0 z-10 grid gap-3 border-t border-line bg-paper py-4"
        >
          <div>
            <p className="text-xs text-muted">{sideProps.title}</p>
            <p data-testid="editor-sentence" aria-live="polite" className="text-[15px] font-medium leading-snug text-ink [overflow-wrap:anywhere]">
              <Sentence parts={form.sentence} links={false} />
            </p>
          </div>
          <EditorNotices {...sideProps} />
          <EditorFooter {...sideProps} />
        </div>
      )}
      {leave.status === "blocked" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => { if (!open) leave.reset(); }}
          title="Leave without saving?"
          description={`This ${form.routine ? "routine" : "line"} has changes that are not saved. If you leave now, the changes are lost. To keep them, stay on this page and select Save.`}
          confirmLabel="Leave without saving"
          onConfirm={leave.proceed}
        />
      )}
    </section>
  );
}
