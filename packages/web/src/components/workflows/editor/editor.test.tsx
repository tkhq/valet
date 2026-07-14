// @vitest-environment jsdom
/**
 * Editor composition (Task 10): field edit -> dirty indicator -> Save
 * calls onSave with the updated definition; invalid definition shows the
 * banner and disables Save; the JSON toggle round-trips through the same
 * definition state.
 *
 * No `@testing-library/jest-dom` in this package, so assertions read raw
 * DOM properties (`.disabled`, `.value`) instead of `toBeDisabled`/
 * `toHaveValue`. Node selection clicks the canvas node's summary text
 * (e.g. "hello", the llm node's prompt) rather than its type label — the
 * palette renders a same-named "LLM" button that `getByText("LLM")` would
 * also match.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { WorkflowDefinition } from "@valet/workflow";
import { Editor } from "./editor";

function baseDefinition(): WorkflowDefinition {
  return {
    version: "dag/v1",
    nodes: [
      { id: "trigger", type: "trigger" },
      { id: "llm-1", type: "llm", model: "claude-haiku", prompt: "hello" },
      { id: "stop", type: "stop", outcome: "success" },
    ],
    edges: [
      { from: "trigger", to: "llm-1" },
      { from: "llm-1", to: "stop" },
    ],
    ui: {
      nodes: {
        trigger: { position: { x: 0, y: 0 } },
        "llm-1": { position: { x: 260, y: 0 } },
        stop: { position: { x: 520, y: 0 } },
      },
    },
  };
}

describe("Editor", () => {
  it("has no unsaved indicator and a disabled Save button before any edit", () => {
    render(<Editor initialDefinition={baseDefinition()} onSave={vi.fn()} />);
    expect(screen.queryByTestId("unsaved-indicator")).toBeNull();
    const saveButton = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
  });

  it("shows the unsaved indicator and enables Save after a field edit, and Save fires onSave with the updated definition", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<Editor initialDefinition={baseDefinition()} onSave={onSave} />);

    fireEvent.click(screen.getByText("hello"));
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "updated prompt" } });

    expect(screen.getByTestId("unsaved-indicator")).toBeTruthy();
    const saveButton = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);

    fireEvent.click(saveButton);

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0]![0] as WorkflowDefinition;
    const llmNode = saved.nodes.find((n) => n.id === "llm-1");
    expect(llmNode).toMatchObject({ prompt: "updated prompt" });
  });

  it("surfaces a save-error line when onSave rejects, and leaves the definition dirty", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("network unreachable"));
    render(<Editor initialDefinition={baseDefinition()} onSave={onSave} />);

    fireEvent.click(screen.getByText("hello"));
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "updated prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText("network unreachable")).toBeTruthy();
    // Still dirty — the failed save didn't silently clear the indicator.
    expect(screen.getByTestId("unsaved-indicator")).toBeTruthy();
  });

  it("Cancel discards edits back to the last-saved definition and is disabled when clean", () => {
    render(<Editor initialDefinition={baseDefinition()} onSave={vi.fn()} />);

    const cancelButton = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancelButton.disabled).toBe(true);

    fireEvent.click(screen.getByText("hello"));
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "updated prompt" } });
    expect(cancelButton.disabled).toBe(false);

    fireEvent.click(cancelButton);

    expect(screen.queryByTestId("unsaved-indicator")).toBeNull();
    expect(cancelButton.disabled).toBe(true);
    fireEvent.click(screen.getByText("hello"));
    const promptField = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    expect(promptField.value).toBe("hello");
  });

  it("shows the validation banner and disables Save for an invalid definition", () => {
    const invalid: WorkflowDefinition = {
      ...baseDefinition(),
      nodes: [
        { id: "trigger", type: "trigger" },
        { id: "llm-1", type: "llm", model: "", prompt: "" },
        { id: "stop", type: "stop", outcome: "success" },
      ],
    };
    render(<Editor initialDefinition={invalid} onSave={vi.fn()} />);

    fireEvent.click(screen.getByText("No prompt configured"));
    fireEvent.change(screen.getByLabelText("System"), { target: { value: "be terse" } });

    expect(screen.getByRole("alert")).toBeTruthy();
    const saveButton = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
  });

  it("round-trips the definition through the JSON toggle", () => {
    render(<Editor initialDefinition={baseDefinition()} onSave={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit JSON" }));
    const textarea = screen.getByLabelText("Definition (JSON)") as HTMLTextAreaElement;
    const asObject = JSON.parse(textarea.value) as WorkflowDefinition;
    const updatedText = textarea.value.replace('"hello"', '"hello from json"');
    expect(asObject.nodes.some((n) => n.id === "llm-1")).toBe(true);

    fireEvent.change(textarea, { target: { value: updatedText } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(screen.getByTestId("unsaved-indicator")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Visual editor" }));
    fireEvent.click(screen.getByText("hello from json"));
    const promptField = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    expect(promptField.value).toBe("hello from json");
  });
});
