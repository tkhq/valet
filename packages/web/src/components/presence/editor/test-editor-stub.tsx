/**
 * A stand-in for `LineEditor` in tests of its launch points. It renders the
 * mode it was opened with as one line of text, so a test asserts which
 * mode each launch point passes without mounting the editor and its reads.
 *
 * Use it from a `vi.mock` factory:
 * `vi.mock("~/components/presence/editor/line-editor", async () => (await import("~/components/presence/editor/test-editor-stub")).stubModule);`
 */
import type { EditorMode } from "./draft";

/** A mode in words: `create place slack:T1:C900`, `edit R4 at appears`, `review R4 replaces R1`. */
export function editorModeText(mode: EditorMode): string {
  const at = mode.initialSection !== undefined ? ` at ${mode.initialSection}` : "";
  switch (mode.kind) {
    case "create": {
      const p = mode.preselected;
      const parts = [
        ...(p?.place !== undefined ? [`place ${p.place.subject}`] : []),
        ...(p?.workflowId !== undefined ? [`workflow ${p.workflowId}`] : []),
        ...(p?.fixedWorkflowId !== undefined ? [`fixed workflow ${p.fixedWorkflowId}`] : []),
        ...(p?.schedule === true ? ["schedule"] : []),
        ...(p?.team !== undefined ? [`team ${p.team.name} (${p.team.id})`] : []),
      ];
      return `create${parts.length > 0 ? ` ${parts.join(" ")}` : ""}${at}`;
    }
    case "edit":
      return `edit ${mode.line.name}${at}`;
    case "edit-routine":
      return `edit-routine ${mode.routine.name}${at}`;
    case "review":
      return `review ${mode.line.name}${mode.replaces !== undefined ? ` replaces ${mode.replaces.name}` : ""}${at}`;
  }
}

export function LineEditorStub({ open, mode }: { open: boolean; mode: EditorMode }) {
  return open ? <p data-testid="line-editor">Editor: {editorModeText(mode)}</p> : null;
}

export const stubModule = { LineEditor: LineEditorStub };
