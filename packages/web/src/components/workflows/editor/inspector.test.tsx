// @vitest-environment jsdom
/**
 * Inspector (Task 10): renders the right per-type form and propagates a
 * field edit as an `onChange` patch. Also covers the foreach body
 * sub-form (type switch + nested field edit) since it's the one place
 * that reuses the per-type forms recursively.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ForeachNode, LlmNode, SessionNode, TriggerNode, WorkflowNode } from "@valet/workflow";
import { Inspector } from "./inspector";

function noop() {}

describe("Inspector", () => {
  it("renders the llm form for an llm node and propagates a prompt edit", () => {
    const onChange = vi.fn();
    const node: LlmNode = { id: "llm-1", type: "llm", model: "claude-haiku", prompt: "hello" };
    render(<Inspector node={node} onChange={onChange} onRemove={noop} onDuplicate={noop} />);

    expect(screen.getByLabelText("Model")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "hello world" } });
    expect(onChange).toHaveBeenCalledWith({ prompt: "hello world" });
  });

  it("renders the session form for a session node", () => {
    const node: SessionNode = { id: "s-1", type: "session", mode: "start", prompt: "do it" };
    render(<Inspector node={node} onChange={noop} onRemove={noop} onDuplicate={noop} />);
    expect(screen.getByLabelText("Prompt")).toBeTruthy();
    expect(screen.getByLabelText("Wait mode")).toBeTruthy();
  });

  it("renders a read-only view for the trigger node with no remove/duplicate buttons", () => {
    const node: TriggerNode = { id: "trigger", type: "trigger" };
    render(<Inspector node={node} onChange={noop} onRemove={noop} onDuplicate={noop} />);
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Duplicate" })).toBeNull();
  });

  it("fires onRemove and onDuplicate for a non-trigger node", () => {
    const onRemove = vi.fn();
    const onDuplicate = vi.fn();
    const node: WorkflowNode = { id: "wait-1", type: "wait", mode: "duration", duration: "5m" };
    render(<Inspector node={node} onChange={noop} onRemove={onRemove} onDuplicate={onDuplicate} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    expect(onRemove).toHaveBeenCalled();
    expect(onDuplicate).toHaveBeenCalled();
  });

  describe("foreach body sub-form", () => {
    function foreachNode(): ForeachNode {
      return {
        id: "foreach-1",
        type: "foreach",
        items: "{{trigger.items}}",
        body: { id: "foreach-1-body", type: "set", values: {} },
      };
    }

    it("renders the set form by default and edits propagate as a whole-body patch", () => {
      const onChange = vi.fn();
      render(<Inspector node={foreachNode()} onChange={onChange} onRemove={noop} onDuplicate={noop} />);
      fireEvent.click(screen.getByRole("button", { name: "Add value" }));
      expect(onChange).toHaveBeenCalledWith({
        body: { id: "foreach-1-body", type: "set", values: { "": "" } },
      });
    });

    it("switching the body type replaces the body with a default node of that type", () => {
      const onChange = vi.fn();
      render(<Inspector node={foreachNode()} onChange={onChange} onRemove={noop} onDuplicate={noop} />);
      fireEvent.change(screen.getByLabelText("Body type"), { target: { value: "llm" } });
      expect(onChange).toHaveBeenCalledWith({
        body: { id: "foreach-1-body", type: "llm", model: "", prompt: "" },
      });
    });

    it("editing a field on a non-set body type patches the whole body object", () => {
      const onChange = vi.fn();
      const node: ForeachNode = {
        ...foreachNode(),
        body: { id: "foreach-1-body", type: "llm", model: "claude-haiku", prompt: "" },
      };
      render(<Inspector node={node} onChange={onChange} onRemove={noop} onDuplicate={noop} />);
      const promptInputs = screen.getAllByLabelText("Prompt");
      fireEvent.change(promptInputs[promptInputs.length - 1]!, { target: { value: "summarize" } });
      expect(onChange).toHaveBeenCalledWith({
        body: { id: "foreach-1-body", type: "llm", model: "claude-haiku", prompt: "summarize" },
      });
    });
  });
});
