// @vitest-environment jsdom
/**
 * Revert-confirm dialog: names the target revision (id, summary, age) and
 * requires an explicit Confirm — the history panel's button used to revert
 * immediately on click.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DesignRevisionSummary } from "@valet/api/wire";
import { DesignPanelRevertConfirm } from "./design-panel-revert-confirm";

const TARGET: DesignRevisionSummary = {
  revision: "r-002",
  summary: "Tightened the intro slide",
  turnId: null,
  createdAt: Date.now() - 2 * 60 * 60 * 1000,
};

function renderDialog(overrides?: Partial<Parameters<typeof DesignPanelRevertConfirm>[0]>) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <DesignPanelRevertConfirm
      target={TARGET}
      tokens={{}}
      isSlides={false}
      pending={false}
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
  return { onConfirm, onCancel };
}

describe("DesignPanelRevertConfirm", () => {
  it("names the target revision, summary, and age", () => {
    renderDialog();
    expect(screen.getByText("Revert to r-002?")).toBeTruthy();
    expect(screen.getByText(/Tightened the intro slide/)).toBeTruthy();
    expect(screen.getByText(/2h ago/)).toBeTruthy();
  });

  it("Revert only fires on Confirm; Cancel calls onCancel", async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderDialog();
    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Confirm calls onConfirm", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Revert" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("pending disables both buttons and relabels Confirm", () => {
    renderDialog({ pending: true });
    const confirm = screen.getByRole<HTMLButtonElement>("button", { name: "Reverting…" });
    const cancel = screen.getByRole<HTMLButtonElement>("button", { name: "Cancel" });
    expect(confirm.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
  });

  it("shows the loading state while the preview fetch runs", () => {
    renderDialog({ previewLoading: true });
    expect(screen.getByText("Loading the preview…")).toBeTruthy();
  });

  it("falls back to a no-preview note when content is unreachable", () => {
    renderDialog();
    expect(screen.getByText("No preview is available for this revision.")).toBeTruthy();
  });

  it("shows the server error inline", () => {
    renderDialog({ error: "The revert failed. Retry." });
    expect(screen.getByText("The revert failed. Retry.")).toBeTruthy();
  });
});
