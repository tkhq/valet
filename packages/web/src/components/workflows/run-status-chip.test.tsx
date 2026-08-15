// @vitest-environment jsdom
/**
 * RunStatusChip: displays a status chip that reflects run state,
 * with a special "Needs approval" chip when needsApproval is true.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunStatusChip } from "./run-status-chip";

describe("RunStatusChip", () => {
  it("renders 'Needs approval' when needsApproval is true", () => {
    render(<RunStatusChip status="parked" needsApproval={true} />);
    expect(screen.getByText("Needs approval")).toBeTruthy();
  });

  it("renders the outcome badge text when settled with an outcome", () => {
    render(<RunStatusChip status="settled" outcome="completed" needsApproval={false} />);
    expect(screen.getByText("completed")).toBeTruthy();
  });

  it("renders 'Waiting' when parked but needsApproval is false", () => {
    render(<RunStatusChip status="parked" needsApproval={false} />);
    expect(screen.getByText("Waiting")).toBeTruthy();
  });

  it("renders 'Running' when status is running", () => {
    render(<RunStatusChip status="running" needsApproval={false} />);
    expect(screen.getByText("Running")).toBeTruthy();
  });

  it("renders 'Running' when status is pending", () => {
    render(<RunStatusChip status="pending" needsApproval={false} />);
    expect(screen.getByText("Running")).toBeTruthy();
  });
});
