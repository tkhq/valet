// @vitest-environment jsdom
/**
 * Approval card (plan decision 19): Approve/Deny must fire
 * `useResolveApproval`'s mutation with the right `nodeId` and `approved`
 * value, carrying an optional note.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ApprovalCard } from "./approval-card";

const mutate = vi.fn();

vi.mock("~/api/workflows", () => ({
  useResolveApproval: () => ({ mutate, isPending: false, isError: false }),
}));

describe("ApprovalCard", () => {
  it("renders the prompt when provided, else a fallback with the node id", () => {
    render(<ApprovalCard runId="wfrun_1" nodeId="deploy" prompt="Ship it?" />);
    expect(screen.getByText("Ship it?")).toBeTruthy();
  });

  it("falls back to a generic label when no prompt is given", () => {
    render(<ApprovalCard runId="wfrun_1" nodeId="deploy" />);
    expect(screen.getByText("Approval required: deploy")).toBeTruthy();
  });

  it("calls the mutation with approved: true on Approve", () => {
    mutate.mockClear();
    render(<ApprovalCard runId="wfrun_1" nodeId="deploy" prompt="Ship it?" />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(mutate).toHaveBeenCalledWith({
      nodeId: "deploy",
      body: { approved: true, note: undefined },
    });
  });

  it("calls the mutation with approved: false on Deny", () => {
    mutate.mockClear();
    render(<ApprovalCard runId="wfrun_1" nodeId="deploy" prompt="Ship it?" />);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(mutate).toHaveBeenCalledWith({
      nodeId: "deploy",
      body: { approved: false, note: undefined },
    });
  });

  it("includes a trimmed note when one is entered", () => {
    mutate.mockClear();
    render(<ApprovalCard runId="wfrun_1" nodeId="deploy" prompt="Ship it?" />);
    fireEvent.change(screen.getByPlaceholderText("Optional note"), {
      target: { value: "  looks good  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(mutate).toHaveBeenCalledWith({
      nodeId: "deploy",
      body: { approved: true, note: "looks good" },
    });
  });
});
