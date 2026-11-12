// @vitest-environment jsdom
/** `ConfirmDialog`: the server error under the footer uses the measured danger text color. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./confirm-dialog";

afterEach(cleanup);

describe("ConfirmDialog", () => {
  it("shows the error in danger-text", () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Delete workflow"
        description="This removes the workflow and its runs."
        confirmLabel="Delete"
        error="The server refused the delete. Try again."
        onConfirm={vi.fn()}
      />,
    );
    const error = screen.getByText("The server refused the delete. Try again.");
    expect(error.tagName).toBe("P");
    expect(error.classList.contains("text-danger-text")).toBe(true);
    expect(error.classList.contains("text-danger-500")).toBe(false);
    expect(screen.getByRole("button", { name: "Delete" }).classList.contains("bg-danger-600")).toBe(true);
  });
});
