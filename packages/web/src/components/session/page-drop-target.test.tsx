// @vitest-environment jsdom
/**
 * Whole-viewport drop target for images. Coexists with the composer's
 * form-level drop handlers: `pointer-events-none` on the overlay lets
 * drops fall through to the form, and containment against
 * `intake.ownedEl` skips our intake when the form already ate the drop.
 */
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  ComposerDropContext,
  type ComposerDropIntake,
  type ComposerDropChannel,
} from "./composer-drop-context";
import { PageDropTarget } from "./page-drop-target";

function mountWithIntake(intake: ComposerDropIntake, children: ReactNode = null) {
  const channel: ComposerDropChannel = {
    intake,
    publish: () => {
      /* not exercised here */
    },
  };
  return render(
    <ComposerDropContext.Provider value={channel}>
      <PageDropTarget>{children}</PageDropTarget>
    </ComposerDropContext.Provider>,
  );
}

/**
 * `fireEvent.dragEnter/drop` on `document` in jsdom doesn't carry a
 * `dataTransfer` payload, so build the event by hand and dispatch it.
 */
function dispatchDrag(name: "dragenter" | "dragover" | "dragleave" | "drop", init: {
  target?: EventTarget;
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
  if (init.target) {
    Object.defineProperty(event, "target", { value: init.target });
  }
  document.dispatchEvent(event);
  return event;
}

function png(name: string): File {
  return new File(["bytes"], name, { type: "image/png" });
}

describe("PageDropTarget", () => {
  it("hands a whole-page drop to intake.addFiles", () => {
    const addFiles = vi.fn();
    mountWithIntake({ addFiles, blocked: false, ownedEl: null });
    const file = png("dropped.png");

    act(() => {
      dispatchDrag("dragenter", { files: [file] });
      dispatchDrag("dragover", { files: [file] });
      dispatchDrag("drop", { files: [file] });
    });

    expect(addFiles).toHaveBeenCalledTimes(1);
    const files = addFiles.mock.calls[0][0] as File[];
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("dropped.png");
  });

  it("shows the overlay while a file drag is over the page", () => {
    const addFiles = vi.fn();
    const { getByTestId, queryByTestId } = mountWithIntake({
      addFiles,
      blocked: false,
      ownedEl: null,
    });

    expect(queryByTestId("page-drop-overlay")).toBeNull();
    act(() => {
      dispatchDrag("dragenter", { files: [png("hover.png")] });
    });
    expect(getByTestId("page-drop-overlay")).toBeDefined();

    act(() => {
      dispatchDrag("dragleave", {});
    });
    expect(queryByTestId("page-drop-overlay")).toBeNull();
  });

  it("does not activate for non-file drags (text, links)", () => {
    const addFiles = vi.fn();
    const { queryByTestId } = mountWithIntake({ addFiles, blocked: false, ownedEl: null });

    act(() => {
      dispatchDrag("dragenter", { types: ["text/plain"] });
      dispatchDrag("drop", { types: ["text/plain"] });
    });

    expect(queryByTestId("page-drop-overlay")).toBeNull();
    expect(addFiles).not.toHaveBeenCalled();
  });

  it("skips intake when the drop target is inside intake.ownedEl", () => {
    const addFiles = vi.fn();
    // Composer's form: a real DOM node the intake claims as its own.
    const owned = document.createElement("form");
    const inner = document.createElement("textarea");
    owned.appendChild(inner);
    document.body.appendChild(owned);

    mountWithIntake({ addFiles, blocked: false, ownedEl: owned });

    act(() => {
      dispatchDrag("drop", { target: inner, files: [png("on-form.png")] });
    });

    expect(addFiles).not.toHaveBeenCalled();
    document.body.removeChild(owned);
  });

  it("refuses intake while blocked", () => {
    const addFiles = vi.fn();
    const { queryByTestId } = mountWithIntake({ addFiles, blocked: true, ownedEl: null });

    act(() => {
      dispatchDrag("dragenter", { files: [png("x.png")] });
      dispatchDrag("drop", { files: [png("x.png")] });
    });

    // Overlay never opens for a blocked intake, and no files get through.
    expect(queryByTestId("page-drop-overlay")).toBeNull();
    expect(addFiles).not.toHaveBeenCalled();
  });

  it("renders its children", () => {
    const { getByText } = mountWithIntake(
      { addFiles: () => {}, blocked: false, ownedEl: null },
      <p>child body</p>,
    );
    expect(getByText("child body")).toBeDefined();
  });
});

// Silence: fireEvent is imported but not used inline (we go through
// dispatchDrag). Keeping the import listed here signals intent for tests
// added later that want React-synthetic event helpers.
void fireEvent;
