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
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorkflowDefinition } from "@valet/workflow";
import { ApiError } from "~/api/client";
import { Editor } from "./editor";

/**
 * Stands in for the assistant conversation the page passes into the right-
 * hand column. It counts its own mounts, because the property that matters
 * is that selecting a step does NOT restart it: the real panel holds a live
 * session socket and whatever is half-typed in its composer.
 */
let assistantMounts = 0;
function AssistantStub() {
  useEffect(() => {
    assistantMounts += 1;
  }, []);
  return <p>the conversation</p>;
}

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

  it("surfaces the server's per-field errors[] instead of the flattened ApiError message", async () => {
    const onSave = vi
      .fn()
      .mockRejectedValue(
        new ApiError(400, "PUT /workflows/wf_1 → 400", {
          error: "invalid workflow definition",
          errors: ["duplicate node id: a", "unknown edge target: b"],
        }),
      );
    render(<Editor initialDefinition={baseDefinition()} onSave={onSave} />);

    fireEvent.click(screen.getByText("hello"));
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "updated prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText("duplicate node id: a; unknown edge target: b")).toBeTruthy();
  });

  it("folds externalDirty into the unsaved indicator and Save/Cancel enablement, and Cancel calls onCancelExternal", () => {
    const onCancelExternal = vi.fn();
    render(
      <Editor
        initialDefinition={baseDefinition()}
        onSave={vi.fn()}
        externalDirty
        onCancelExternal={onCancelExternal}
      />,
    );

    // No definition edit was made, but externalDirty alone should still
    // show the indicator and enable Save/Cancel (a rename with no
    // definition change still needs to ride the same Save button).
    expect(screen.getByTestId("unsaved-indicator")).toBeTruthy();
    const saveButton = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    const cancelButton = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancelButton.disabled).toBe(false);

    fireEvent.click(cancelButton);
    expect(onCancelExternal).toHaveBeenCalledTimes(1);
  });

  // The assistant panel patches the stored workflow directly, the page
  // refetches, and the new definition arrives here as a changed
  // `initialDefinition`. These cover what the editor does with it.
  describe("when the assistant changes the workflow on the server", () => {
    function patched(): WorkflowDefinition {
      const base = baseDefinition();
      return {
        ...base,
        nodes: [...base.nodes, { id: "wait-1", type: "wait", mode: "duration", duration: "30s" }],
        edges: [
          { from: "trigger", to: "llm-1" },
          { from: "llm-1", to: "wait-1" },
          { from: "wait-1", to: "stop" },
        ],
      };
    }

    it("adopts the change on a clean canvas, with no reload and no prompt", () => {
      const { rerender } = render(
        <Editor initialDefinition={baseDefinition()} onSave={vi.fn()} />,
      );
      // "30s" is the wait node's canvas summary. Asserting on that rather
      // than its "Wait" type label, which the palette also renders.
      expect(screen.queryByText("30s")).toBeNull();

      rerender(<Editor initialDefinition={patched()} onSave={vi.fn()} />);

      // The added step is on the canvas, and adopting a server edit is not
      // an unsaved local edit.
      expect(screen.getByText("30s")).toBeTruthy();
      expect(screen.queryByTestId("unsaved-indicator")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("keeps unsaved edits and asks, rather than overwriting them", () => {
      const { rerender } = render(
        <Editor initialDefinition={baseDefinition()} onSave={vi.fn()} />,
      );
      fireEvent.click(screen.getByText("hello"));
      fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "my draft" } });

      rerender(<Editor initialDefinition={patched()} onSave={vi.fn()} />);

      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("changed this workflow while you were editing");
      // The corrective actions are both named, and the draft survives.
      expect(alert.textContent).toContain("Reload");
      expect(alert.textContent).toContain("Save");
      expect(screen.getByTestId("unsaved-indicator")).toBeTruthy();
      expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("my draft");
    });

    it("takes the server's version when Reload is pressed", () => {
      const { rerender } = render(
        <Editor initialDefinition={baseDefinition()} onSave={vi.fn()} />,
      );
      fireEvent.click(screen.getByText("hello"));
      fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "my draft" } });
      rerender(<Editor initialDefinition={patched()} onSave={vi.fn()} />);

      fireEvent.click(screen.getByRole("button", { name: "Reload" }));

      expect(screen.getByText("30s")).toBeTruthy();
      expect(screen.queryByTestId("unsaved-indicator")).toBeNull();
      expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("hello");
    });

    it("does not adopt or warn when a re-render carries the same graph", () => {
      const { rerender } = render(
        <Editor initialDefinition={baseDefinition()} onSave={vi.fn()} />,
      );
      fireEvent.click(screen.getByText("hello"));
      fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "my draft" } });

      // A fresh object with identical content — what a refetch produces
      // when nothing actually changed.
      rerender(
        <Editor initialDefinition={baseDefinition()} onSave={vi.fn()} />,
      );

      expect(screen.queryByRole("alert")).toBeNull();
      expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("my draft");
    });

    it("holds the saved edit while the refetch that follows the save is still in flight", async () => {
      // The page invalidates on a successful save, so for one moment the
      // query still answers with the PRE-save definition. Reverting to it
      // would undo the save on screen and then flip back.
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(<Editor initialDefinition={baseDefinition()} onSave={onSave} />);
      fireEvent.click(screen.getByText("hello"));
      fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "saved prompt" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

      await waitFor(() =>
        expect(screen.queryByTestId("unsaved-indicator")).toBeNull(),
      );
      expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("saved prompt");
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("does not cry conflict when a save comes back with its keys reordered", async () => {
      // The definition is stored in a `jsonb` column, which returns object
      // keys in the database's order, not the order this client sent them.
      // Save, keep typing, and the refetch that follows the save must not
      // read as somebody else's edit.
      const onSave = vi.fn().mockResolvedValue(undefined);
      const { rerender } = render(
        <Editor initialDefinition={baseDefinition()} onSave={onSave} />,
      );
      fireEvent.click(screen.getByText("hello"));
      fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "saved prompt" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

      fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "still typing" } });

      const reordered: WorkflowDefinition = {
        ...baseDefinition(),
        nodes: [
          { type: "trigger", id: "trigger" },
          { prompt: "saved prompt", model: "claude-haiku", type: "llm", id: "llm-1" },
          { outcome: "success", type: "stop", id: "stop" },
        ],
      };
      rerender(<Editor initialDefinition={reordered} onSave={onSave} />);

      expect(screen.queryByRole("alert")).toBeNull();
      expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("still typing");
    });
  });

  // One column to the right of the canvas holds both ways of changing a
  // workflow. It used to hold a card that summarised the definition and
  // offered a button to open the conversation somewhere else.
  describe("the right-hand column", () => {
    it("is the assistant while nothing is selected", () => {
      render(
        <Editor
          initialDefinition={baseDefinition()}
          onSave={vi.fn()}
          assistant={<AssistantStub />}
        />,
      );
      expect(screen.getByText("the conversation")).toBeTruthy();
      expect(screen.queryByTestId("inspector")).toBeNull();
      expect(screen.queryByRole("button", { name: "Open the assistant" })).toBeNull();
    });

    it("gives the column to the selected step's form, and takes it back again", () => {
      assistantMounts = 0;
      render(
        <Editor
          initialDefinition={baseDefinition()}
          onSave={vi.fn()}
          assistant={<AssistantStub />}
        />,
      );
      expect(assistantMounts).toBe(1);

      fireEvent.click(screen.getByText("hello"));
      expect(screen.getByTestId("inspector")).toBeTruthy();
      expect(screen.getByLabelText("Prompt")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Assistant" }));
      expect(screen.queryByTestId("inspector")).toBeNull();
      expect(screen.getByText("the conversation")).toBeTruthy();
      // The whole point of covering the conversation rather than swapping
      // it out: it was never torn down and restarted.
      expect(assistantMounts).toBe(1);
    });

    it("keeps the conversation out of reach while a step's form covers it", () => {
      const { container } = render(
        <Editor
          initialDefinition={baseDefinition()}
          onSave={vi.fn()}
          assistant={<AssistantStub />}
        />,
      );
      expect(container.querySelector("[inert]")).toBeNull();

      fireEvent.click(screen.getByText("hello"));

      // Mounted, but inert: one of the two answers the keyboard and the
      // screen reader, not both.
      expect(container.querySelector("[inert]")).toBeTruthy();
    });
  });

  it("round-trips the definition through the JSON toggle", async () => {
    const user = userEvent.setup();
    render(<Editor initialDefinition={baseDefinition()} onSave={vi.fn()} />);

    // JSON mode is deliberately behind the overflow menu now — the
    // assistant panel is the promoted path — but it must still be reachable.
    await user.click(screen.getByRole("button", { name: "More editor actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit JSON" }));
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
