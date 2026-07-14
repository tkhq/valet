// @vitest-environment jsdom
/**
 * EdgeInspector (Task 10): edits `when` always, and `fromOutput` only when
 * the source node is `if` or `approval` (the only types that render
 * true/false source handles — everything else is a single unconditional
 * edge).
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { EdgeInspector } from "./edge-inspector";
import type { WorkflowFlowEdge } from "../editor-model";

function edge(overrides: Partial<WorkflowFlowEdge> = {}): WorkflowFlowEdge {
  return {
    id: "check->stop",
    source: "check",
    target: "stop",
    data: {},
    ...overrides,
  };
}

function noop() {}

describe("EdgeInspector", () => {
  it("shows the fromOutput select for an if source", () => {
    render(<EdgeInspector edge={edge()} sourceNodeType="if" onChange={noop} onRemove={noop} />);
    expect(screen.getByLabelText("From output")).toBeTruthy();
  });

  it("shows the fromOutput select for an approval source", () => {
    render(<EdgeInspector edge={edge()} sourceNodeType="approval" onChange={noop} onRemove={noop} />);
    expect(screen.getByLabelText("From output")).toBeTruthy();
  });

  it("hides the fromOutput select for any other source type", () => {
    render(<EdgeInspector edge={edge()} sourceNodeType="set" onChange={noop} onRemove={noop} />);
    expect(screen.queryByLabelText("From output")).toBeNull();
  });

  it("propagates a when edit", () => {
    const onChange = vi.fn();
    render(<EdgeInspector edge={edge()} sourceNodeType="set" onChange={onChange} onRemove={noop} />);
    fireEvent.change(screen.getByLabelText("When (condition expression)"), { target: { value: "approved" } });
    expect(onChange).toHaveBeenCalledWith({ when: "approved" });
  });

  it("propagates a fromOutput edit", () => {
    const onChange = vi.fn();
    render(<EdgeInspector edge={edge()} sourceNodeType="if" onChange={onChange} onRemove={noop} />);
    fireEvent.change(screen.getByLabelText("From output"), { target: { value: "true" } });
    expect(onChange).toHaveBeenCalledWith({ fromOutput: "true" });
  });

  it("fires onRemove", () => {
    const onRemove = vi.fn();
    render(<EdgeInspector edge={edge()} sourceNodeType="set" onChange={noop} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove edge" }));
    expect(onRemove).toHaveBeenCalled();
  });
});
