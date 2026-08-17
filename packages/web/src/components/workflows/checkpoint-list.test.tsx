// @vitest-environment jsdom
/**
 * Checkpoint list: raw checkpoint status strings map to the canvas's
 * `NodeRunStatus` labels, a failure's error and result are visible without
 * clicking anything, and a successful node's result stays collapsed by
 * default so a long run doesn't bury the row that needs attention.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CheckpointList } from "./checkpoint-list";

describe("CheckpointList", () => {
  it("shows a fallback line when there are no checkpoints", () => {
    render(<CheckpointList checkpoints={[]} />);
    expect(screen.getByText("No checkpoints yet.")).toBeTruthy();
  });

  it("maps raw statuses to their display labels", () => {
    render(
      <CheckpointList
        checkpoints={[
          { nodeId: "fetch", iteration: 0, status: "completed" },
          { nodeId: "deploy", iteration: 0, status: "failed" },
          { nodeId: "notify", iteration: 0, status: "intent" },
          { nodeId: "cleanup", iteration: 0, status: "skipped" },
        ]}
      />,
    );
    expect(screen.getByText("Completed")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("Skipped")).toBeTruthy();
  });

  it("shows a failed node's error inline, not behind a toggle", () => {
    render(
      <CheckpointList
        checkpoints={[{ nodeId: "deploy", iteration: 0, status: "failed", error: "timed out" }]}
      />,
    );
    expect(screen.getByText("timed out")).toBeTruthy();
  });

  it("opens the result details by default for a failed node", () => {
    render(
      <CheckpointList
        checkpoints={[
          { nodeId: "deploy", iteration: 0, status: "failed", result: { code: 1 } },
        ]}
      />,
    );
    const details = screen.getByText("Result").closest("details");
    expect(details?.open).toBe(true);
  });

  it("leaves the result details closed by default for a succeeded node", () => {
    render(
      <CheckpointList
        checkpoints={[
          { nodeId: "fetch", iteration: 0, status: "completed", result: { rows: 12 } },
        ]}
      />,
    );
    const details = screen.getByText("Result").closest("details");
    expect(details?.open).toBe(false);
  });
});
