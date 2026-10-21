/**
 * The editor (docs/specs/2026-10-16-presence-hub-design.md Part H): one
 * full-height sheet that creates a line of presence or a routine, reviews
 * a proposal, and edits from a row. A line's or a routine's own page edits
 * inline instead (`InlineEditor`); both read `useEditorForm`. The form on
 * the left lists the sections When, Do, Where, Appears as, and Name; the
 * side pane on the right reads the sentence the draft will store, a worked
 * example, the warnings, and Create or Save.
 *
 * The sheet mounts when it opens, so the draft seeds from `mode` at open
 * time. A new mode needs a new open. Esc, Cancel, and a click outside close
 * it; a draft with changes asks `Discard your changes?` first. On close,
 * focus goes back to the element that had it at open.
 */
import { useState } from "react";
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from "~/components/primitives";
import { cn } from "~/lib/cn";
import type { EditorMode } from "./draft";
import type { SectionId } from "./section";
import { SentenceCard, SidePane, SidePaneRest } from "./side-pane";
import { useEditorForm, type EditorSaved } from "./use-editor-form";
import { useIsPhone } from "./use-is-phone";

export type { EditorMode } from "./draft";
export type { EditorSaved } from "./use-editor-form";

/** The controls a section's first focus may land on. */
export const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export function LineEditor(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  mode: EditorMode;
  onSaved?(result: EditorSaved): void;
  /** Where focus goes when the sheet closes, for a launcher that restores it itself. */
  onCloseAutoFocus?(event: Event): void;
}) {
  if (!props.open) return null;
  return <EditorSheet {...props} />;
}

function EditorSheet({ onOpenChange, mode: openedMode, onSaved, onCloseAutoFocus }: {
  onOpenChange(open: boolean): void;
  mode: EditorMode;
  onSaved?(result: EditorSaved): void;
  onCloseAutoFocus?(event: Event): void;
}) {
  const phone = useIsPhone();
  const form = useEditorForm(openedMode, { onSaved, onFinish: () => onOpenChange(false) });
  const { mode, formRef, sideProps } = form;
  const [openSection, setOpenSection] = useState<SectionId | null>(mode.initialSection ?? (mode.kind === "create" ? "when" : null));
  // A section named at open time scrolls into view and takes focus, so a
  // `Change` under Appears as lands on Appears as and not on the top of the
  // form. The dialog's open focus runs once its portal has mounted; an
  // effect here would run before the form exists.
  function openAutoFocus(event: Event) {
    const id = mode.initialSection;
    if (id === undefined) return;
    const section = formRef.current?.querySelector(`[data-section="${id}"]`);
    if (!(section instanceof HTMLElement)) return;
    section.scrollIntoView?.({ block: "start" });
    const body = section.querySelector("[data-section-body]");
    const control = (body ?? section).querySelector<HTMLElement>(FOCUSABLE);
    if (control === null) return;
    event.preventDefault();
    control.focus();
  }
  // The sheet has no Radix trigger, so Radix would send focus to the body
  // when it closes. The element that had focus at open (the launcher's
  // button) takes it back. Every close path (Esc, Cancel, Discard, Done, a
  // save) unmounts the sheet, and the dialog runs this as it unmounts.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  function closeAutoFocus(event: Event) {
    onCloseAutoFocus?.(event);
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (opener?.isConnected === true) opener.focus();
  }

  const content = (
    <>
      <div className="mb-5 flex items-baseline justify-between gap-4">
        <DialogTitle className="min-w-0 text-xl font-medium text-ink [overflow-wrap:anywhere]">{form.heading}</DialogTitle>
        {phone
          ? <Button type="button" variant="ghost" size="sm" onClick={form.requestClose}>Close</Button>
          : <span className="shrink-0 text-[13px] text-muted">Esc to close</span>}
      </div>
      <DialogDescription className="sr-only">
        Choose when Valet acts, what it does, and where. The side pane reads the result.
      </DialogDescription>
      {form.sections({
        isOpen: (id) => openSection === id,
        toggle: (id) => setOpenSection((cur) => (cur === id ? null : id)),
      })}
    </>
  );

  return (
    <Dialog open onOpenChange={(next) => { if (!next) form.requestClose(); }}>
      <DialogContent
        hideClose
        onOpenAutoFocus={openAutoFocus}
        onCloseAutoFocus={closeAutoFocus}
        data-layout={phone ? "phone" : "wide"}
        className={cn(
          "h-[100dvh] max-h-[100dvh] w-full max-w-[1180px] gap-0 overflow-hidden p-0",
          "grid-rows-[minmax(0,1fr)] sm:h-[calc(100dvh-4rem)] sm:max-h-[calc(100dvh-4rem)] sm:w-[calc(100%-2rem)]",
          "max-sm:rounded-none max-sm:border-0",
          phone ? "grid-cols-[minmax(0,1fr)]" : "grid-cols-[minmax(0,7fr)_minmax(0,5fr)]",
        )}
      >
        {phone ? (
          <div className="min-h-0 overflow-y-auto">
            <div data-testid="editor-phone-header" className="sticky top-0 z-10 border-b border-line bg-neutral-100 px-4 py-3 dark:bg-neutral-900">
              <SentenceCard title={sideProps.title} sentence={form.sentence} />
            </div>
            <div className="px-4 py-6">{content}</div>
            <div className="flex flex-col gap-5 bg-neutral-100 px-4 py-6 dark:bg-neutral-900">
              <SidePaneRest {...sideProps} />
            </div>
          </div>
        ) : (
          <>
            <div className="min-h-0 overflow-y-auto border-r border-line px-9 py-7">{content}</div>
            <aside aria-label="Preview" className="flex min-h-0 flex-col gap-5 overflow-y-auto bg-neutral-100 px-8 py-7 dark:bg-neutral-900">
              <SidePane {...sideProps} />
            </aside>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
