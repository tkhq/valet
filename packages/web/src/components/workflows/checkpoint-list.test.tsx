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
  it("shows each step's model spend, marking a lower bound when some calls were unpriced", () => {
    render(
      <CheckpointList
        checkpoints={[
          { nodeId: "draft", iteration: 0, status: "completed" },
          { nodeId: "each", iteration: 1, status: "completed" },
          { nodeId: "notify", iteration: 0, status: "completed" },
        ]}
        stepCosts={[
          { nodeId: "draft", iteration: 0, costUsd: 0.0421, turns: 2, unpricedTurns: 0, totalTokens: 1500, models: ["claude"] },
          { nodeId: "each", iteration: 1, costUsd: 0.005, turns: 2, unpricedTurns: 1, totalTokens: 20, models: [] },
        ]}
      />,
    );
    const [draft, each, notify] = screen.getAllByRole("listitem");
    expect(draft.textContent).toContain("$0.0421");
    expect(draft.textContent).toContain("1.5k tokens over 2 calls · claude");
    expect(each.textContent).toContain("$0.0050+");
    expect(notify.textContent).not.toContain("$");
  });

  it("keeps every status but Completed visible on a phone, where the glyph alone shows a denied step as done", () => {
    render(
      <CheckpointList
        checkpoints={[
          { nodeId: "done", iteration: 0, status: "completed" },
          { nodeId: "blocked", iteration: 0, status: "completed", result: { policyDenied: true } },
          { nodeId: "broken", iteration: 0, status: "failed", error: "boom" },
        ]}
      />,
    );
    // Below `sm` an `sr-only` label is hidden; only the glyph shows.
    expect(screen.getByText("Completed").className).toContain("sr-only");
    expect(screen.getByText("Denied").className).not.toContain("sr-only");
    expect(screen.getByText("Failed").className).not.toContain("sr-only");
  });

  it("shows a fallback line when there are no checkpoints", () => {
    render(<CheckpointList checkpoints={[]} />);
    expect(screen.getByText("No steps have started yet.")).toBeTruthy();
  });

  it("keeps definition order when polling changes row order and status", () => {
    const first = { nodeId: "inventory", iteration: 0, status: "completed" };
    const second = { nodeId: "apply", iteration: 0, status: "intent" };
    const { rerender } = render(<CheckpointList checkpoints={[second, first]} nodeOrder={["inventory", "apply"]} />);
    expect(screen.getAllByRole("listitem")[0].textContent).toContain("inventory");
    rerender(<CheckpointList checkpoints={[first, { ...second, status: "completed" }]} nodeOrder={["inventory", "apply"]} />);
    expect(screen.getAllByRole("listitem")[0].textContent).toContain("inventory");
    expect(screen.getAllByRole("listitem")[1].textContent).toContain("apply");
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

  it("shows waiting rather than running for a parked step and keeps full output available", () => {
    const output = "x".repeat(1000) + "last log line";
    render(<CheckpointList checkpoints={[{ nodeId: "apply", iteration: 0, status: "intent", result: output }]}
      nodeStatuses={{ apply: "waiting" }} />);
    expect(screen.getByText("Waiting")).toBeTruthy();
    expect(screen.queryByText("Running")).toBeNull();
    expect(screen.getByText(output).closest("details")?.open).toBe(true);
  });

  it("labels repeated iterations without marking an earlier completed iteration as waiting", () => {
    render(<CheckpointList checkpoints={[
      { nodeId: "apply", iteration: 0, status: "completed" },
      { nodeId: "apply", iteration: 1, status: "intent" },
    ]} nodeStatuses={{ apply: "waiting" }} />);
    expect(screen.getByText("Completed")).toBeTruthy();
    expect(screen.getByText("Waiting")).toBeTruthy();
    expect(screen.getByText("Iteration 2")).toBeTruthy();
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
