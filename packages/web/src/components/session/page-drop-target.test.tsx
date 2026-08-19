// @vitest-environment jsdom
/**
 * Whole-viewport drop target for images. Coexists with the composer's
 * form-level drop handlers: `pointer-events-none` on the overlay lets
 * drops fall through to the form, and containment against
 * `intake.ownedEl` skips our intake when the form already ate the drop.
 * Each instance only ingests drops inside its own subtree, so two mounted
 * SessionViews (main chat + child panel) never double-ingest one drop.
 */
import { describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  ComposerDropContext,
  type ComposerDropIntake,
  type ComposerDropChannel,
} from "./composer-drop-context";
import { PageDropTarget } from "./page-drop-target";

function mountWithIntake(intake: ComposerDropIntake, children: ReactNode = <p>drop body</p>) {
  const channel: ComposerDropChannel = {
    intake,
    publish: () => {
      /* not exercised here */
    },
  };
  const utils = render(
    <ComposerDropContext.Provider value={channel}>
      <PageDropTarget>{children}</PageDropTarget>
    </ComposerDropContext.Provider>,
  );
  return { ...utils, body: utils.getByText("drop body") };
}

/**
 * `fireEvent.dragEnter/drop` on `document` in jsdom doesn't carry a
 * `dataTransfer` payload, so build the event by hand and dispatch it.
 */
function dispatchDrag(name: "dragenter" | "dragover" | "dragleave" | "drop", init: {
  target: EventTarget;
  files?: File[];
  types?: string[];
}) {
  const event = new Event(name, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types: init.types ?? ["Files"],
      files: init.files ?? [],
      dropEffect: "none",
    },
  });
  Object.defineProperty(event, "target", { value: init.target });
  document.dispatchEvent(event);
  return event;
}

function png(name: string): File {
  return new File(["bytes"], name, { type: "image/png" });
}

describe("PageDropTarget", () => {
  it("hands a drop inside its subtree to intake.addFiles", () => {
    const addFiles = vi.fn();
    const { body } = mountWithIntake({ addFiles, blocked: false, ownedEl: null });
    const file = png("dropped.png");

    act(() => {
      dispatchDrag("dragenter", { target: body, files: [file] });
      dispatchDrag("dragover", { target: body, files: [file] });
      dispatchDrag("drop", { target: body, files: [file] });
    });

    expect(addFiles).toHaveBeenCalledTimes(1);
    const files = addFiles.mock.calls[0][0] as File[];
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("dropped.png");
  });

  it("shows the overlay while a file drag is over its subtree", () => {
    const addFiles = vi.fn();
    const { body, getByTestId, queryByTestId } = mountWithIntake({
      addFiles,
      blocked: false,
      ownedEl: null,
    });

    expect(queryByTestId("page-drop-overlay")).toBeNull();
    act(() => {
      dispatchDrag("dragenter", { target: body, files: [png("hover.png")] });
    });
    expect(getByTestId("page-drop-overlay")).toBeDefined();

    act(() => {
      dispatchDrag("dragleave", { target: body });
    });
    expect(queryByTestId("page-drop-overlay")).toBeNull();
  });

  it("does not activate for non-file drags (text, links)", () => {
    const addFiles = vi.fn();
    const { body, queryByTestId } = mountWithIntake({ addFiles, blocked: false, ownedEl: null });

    act(() => {
      dispatchDrag("dragenter", { target: body, types: ["text/plain"] });
      dispatchDrag("drop", { target: body, types: ["text/plain"] });
    });

    expect(queryByTestId("page-drop-overlay")).toBeNull();
    expect(addFiles).not.toHaveBeenCalled();
  });

  it("ignores drops outside its own subtree (sibling SessionView's area)", () => {
    const addFiles = vi.fn();
    const { queryByTestId } = mountWithIntake({ addFiles, blocked: false, ownedEl: null });
    // A drop that lands elsewhere in the document — e.g. inside another
    // mounted SessionView — must not be ingested by this instance.
    const elsewhere = document.createElement("div");
    document.body.appendChild(elsewhere);

    let dropEvent: Event | undefined;
    act(() => {
      dispatchDrag("dragenter", { target: elsewhere, files: [png("other.png")] });
      dropEvent = dispatchDrag("drop", { target: elsewhere, files: [png("other.png")] });
    });

    expect(queryByTestId("page-drop-overlay")).toBeNull();
    expect(addFiles).not.toHaveBeenCalled();
    // But the default action (browser navigating to the file) is still
    // cancelled — no drop over the app may unload the SPA.
    expect(dropEvent?.defaultPrevented).toBe(true);
    document.body.removeChild(elsewhere);
  });

  it("skips intake when the drop target is inside intake.ownedEl", () => {
    const addFiles = vi.fn();
    // Composer's form: a real DOM node the intake claims as its own.
    const owned = document.createElement("form");
    const inner = document.createElement("textarea");
    owned.appendChild(inner);

    const { body } = mountWithIntake({ addFiles, blocked: false, ownedEl: owned });
    // The form lives inside this instance's subtree, like the real Composer.
    body.appendChild(owned);

    act(() => {
      dispatchDrag("drop", { target: inner, files: [png("on-form.png")] });
    });

    expect(addFiles).not.toHaveBeenCalled();
  });

  it("refuses intake while blocked but still cancels the browser default", () => {
    const addFiles = vi.fn();
    const { body, queryByTestId } = mountWithIntake({ addFiles, blocked: true, ownedEl: null });

    let overEvent: Event | undefined;
    let dropEvent: Event | undefined;
    act(() => {
      dispatchDrag("dragenter", { target: body, files: [png("x.png")] });
      overEvent = dispatchDrag("dragover", { target: body, files: [png("x.png")] });
      dropEvent = dispatchDrag("drop", { target: body, files: [png("x.png")] });
    });

    // Overlay never opens for a blocked intake, and no files get through —
    // but the events are still cancelled so the browser doesn't navigate
    // to the dropped file.
    expect(queryByTestId("page-drop-overlay")).toBeNull();
    expect(addFiles).not.toHaveBeenCalled();
    expect(overEvent?.defaultPrevented).toBe(true);
    expect(dropEvent?.defaultPrevented).toBe(true);
  });

  it("renders its children", () => {
    const { getByText } = mountWithIntake(
      { addFiles: () => {}, blocked: false, ownedEl: null },
      <p>drop body</p>,
    );
    expect(getByText("drop body")).toBeDefined();
  });
});
