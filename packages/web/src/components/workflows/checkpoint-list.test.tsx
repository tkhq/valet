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
    expect(draft.textContent).toContain("1.5k tokens over 2 calls");
    expect(each.textContent).toContain("$0.0050+");
    expect(each.textContent).toContain("Item 2");
    expect(notify.textContent).not.toContain("$");
  });

  it("shows each step's models as text and marks only the first row of a step whose model changed", () => {
    const cost = { costUsd: 0.01, turns: 1, unpricedTurns: 0, totalTokens: 10 };
    render(
      <CheckpointList
        checkpoints={[
          { nodeId: "draft", iteration: 0, status: "completed" },
          { nodeId: "draft", iteration: 1, status: "completed" },
          { nodeId: "review", iteration: 0, status: "completed" },
        ]}
        stepCosts={[
          { ...cost, nodeId: "draft", iteration: 0, models: ["sol-6.1"] },
          { ...cost, nodeId: "draft", iteration: 1, models: ["sol-6.1"] },
          { ...cost, nodeId: "review", iteration: 0, models: ["claude-haiku-4-5"] },
        ]}
        modelChanges={[{ nodeId: "draft", previous: ["sol-5.6"], current: ["sol-6.1"] }]}
      />,
    );
    const chip = "Model changed since the last run: sol-5.6 → sol-6.1. The workflow was not edited.";
    expect(screen.getAllByText(chip)).toHaveLength(1);
    // The step that ran per item is one row; its items open below it.
    const [draft, first, second, review] = screen.getAllByRole("listitem");
    expect(draft.textContent).toContain(chip);
    expect(draft.textContent).toContain("2 items · 2 completed · sol-6.1");
    expect(draft.textContent).toContain("$0.0200");
    expect(first.textContent).toContain("Item 1");
    expect(first.textContent).not.toContain("Model changed");
    expect(second.textContent).toContain("Item 2");
    expect(screen.getAllByText("sol-6.1")).toHaveLength(2);
    expect(review.textContent).toContain("claude-haiku-4-5");
    expect(review.textContent).not.toContain("Model changed");
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
    expect(screen.getAllByRole("listitem")[0].textContent).toContain("Inventory");
    rerender(<CheckpointList checkpoints={[first, { ...second, status: "completed" }]} nodeOrder={["inventory", "apply"]} />);
    expect(screen.getAllByRole("listitem")[0].textContent).toContain("Inventory");
    expect(screen.getAllByRole("listitem")[1].textContent).toContain("Apply");
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
    // The step's row and its waiting item both say Waiting.
    expect(screen.getAllByText("Waiting")).toHaveLength(2);
    expect(screen.getByText("Item 2")).toBeTruthy();
    // A step with an item still waiting opens its item list.
    expect(screen.getByText("Item 2").closest("details")?.open).toBe(true);
  });

  it("shows how long each finished step ran, and a running step's time so far", () => {
    render(<CheckpointList now={10_000} timeline={{ start: 0, end: 10_000 }} checkpoints={[
      { nodeId: "fetch", iteration: 0, status: "completed", startedAt: 1_000, createdAt: 3_500 },
      { nodeId: "apply", iteration: 0, status: "intent", createdAt: 4_000 },
      { nodeId: "legacy", iteration: 0, status: "completed", createdAt: 2_000 },
    ]} nodeOrder={["fetch", "apply", "legacy"]} />);
    const [fetch, apply, legacy] = screen.getAllByRole("listitem");
    expect(fetch.textContent).toContain("2.5s");
    expect(apply.textContent).toContain("6.0s so far");
    // A step recorded before start times were kept shows no duration.
    expect(legacy.textContent).not.toMatch(/\d(ms|s)\b/);
  });

  it("sums a per-item step's items and opens it when an item failed", () => {
    render(<CheckpointList now={0} checkpoints={[
      { nodeId: "qualify_batch", iteration: 0, status: "completed", startedAt: 0, createdAt: 1_000 },
      { nodeId: "qualify_batch", iteration: 1, status: "failed", error: "rate limited", startedAt: 0, createdAt: 3_000 },
      { nodeId: "qualify_batch", iteration: 2, status: "completed", startedAt: 500, createdAt: 2_000 },
    ]} />);
    const [group] = screen.getAllByRole("listitem");
    expect(group.textContent).toContain("Qualify batch");
    expect(group.textContent).toContain("3 items · 2 completed · 1 failed");
    expect(group.textContent).toContain("3.0s");
    expect(screen.getByText("rate limited")).toBeTruthy();
    expect(group.querySelector("details")?.open).toBe(true);
  });

  it("offers a copy button for a step's result", () => {
    render(<CheckpointList checkpoints={[{ nodeId: "fetch", iteration: 0, status: "completed", result: { rows: 12 } }]} />);
    expect(screen.getByRole("button", { name: "Copy result" })).toBeTruthy();
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
