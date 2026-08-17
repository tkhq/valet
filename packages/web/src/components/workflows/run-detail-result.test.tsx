// @vitest-environment jsdom
/**
 * Run result panel: the stop node's message reads as prose, its output reads
 * as structured data, a failure reason gets the same position a success
 * message gets, and a settled run with nothing recorded still names what to
 * do about it.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunResultPanel } from "./run-detail-result";
import type { RunResult } from "./run-detail-helpers";

function result(overrides: Partial<RunResult> = {}): RunResult {
  return { outcome: "completed", diagnostics: [], ...overrides };
}

describe("RunResultPanel", () => {
  it("shows the stop message as prose, not as JSON", () => {
    render(<RunResultPanel result={result({ message: "Opened 3 issues.", nodeId: "done" })} />);
    expect(screen.getByText("Opened 3 issues.")).toBeTruthy();
    expect(screen.getByText("Result")).toBeTruthy();
    expect(screen.getByText("done")).toBeTruthy();
  });

  it("keeps the author's line breaks in the message", () => {
    render(<RunResultPanel result={result({ message: "line one\nline two" })} />);
    const paragraph = screen.getByText(/line one/);
    expect(paragraph.className).toContain("whitespace-pre-wrap");
  });

  it("renders a structured output as JSON under an Output heading", () => {
    render(<RunResultPanel result={result({ output: { count: 3 } })} />);
    expect(screen.getByText("Output")).toBeTruthy();
    expect(screen.getByText(/"count"/)).toBeTruthy();
  });

  it("renders a string output as prose instead of quoted JSON", () => {
    render(<RunResultPanel result={result({ output: "all clear" })} />);
    expect(screen.getByText("all clear")).toBeTruthy();
    expect(screen.queryByText('"all clear"')).toBeNull();
  });

  it("gives a failure reason the same position a success message gets", () => {
    render(
      <RunResultPanel
        result={result({ outcome: "failed", message: "connection refused", nodeId: "fetch" })}
      />,
    );
    expect(screen.getByText("Failure reason")).toBeTruthy();
    expect(screen.getByText("connection refused")).toBeTruthy();
  });

  it("names the corrective action when the run recorded nothing to read", () => {
    render(<RunResultPanel result={result()} />);
    expect(screen.getByText(/set a message on its stop node/i)).toBeTruthy();
  });

  it("tells a reader where to look when a failure recorded no reason", () => {
    render(<RunResultPanel result={result({ outcome: "failed" })} />);
    expect(screen.getByText(/Read the checkpoints below/i)).toBeTruthy();
  });

  it("offers Retry as the action on a cancelled run", () => {
    render(<RunResultPanel result={result({ outcome: "cancelled" })} />);
    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(screen.getByText(/select Retry run/i)).toBeTruthy();
  });

  it("lists unresolved template paths with the action that fixes them", () => {
    render(
      <RunResultPanel
        result={result({
          message: "Assigned to .",
          diagnostics: [
            { path: "trigger.data.owner", nodeId: "assign", detail: "trigger sent no owner" },
          ],
        })}
      />,
    );
    expect(screen.getByText("1 template path did not resolve")).toBeTruthy();
    expect(screen.getByText("trigger.data.owner")).toBeTruthy();
    expect(screen.getByText(/in assign/)).toBeTruthy();
    expect(screen.getByText(/Correct the paths in the workflow/i)).toBeTruthy();
  });

  it("names the field and the working path when the diagnostic carries them", () => {
    render(
      <RunResultPanel
        result={result({
          diagnostics: [
            {
              path: "nodes.draft.result.text",
              nodeId: "draft",
              field: "prompt",
              detail: 'No key "text" on the result of node "draft".',
              suggestion: "nodes.draft.result.response",
            },
          ],
        })}
      />,
    );
    expect(screen.getByText(/in draft\.prompt/)).toBeTruthy();
    expect(screen.getByText(/No key "text"/)).toBeTruthy();
    expect(screen.getByText("nodes.draft.result.response")).toBeTruthy();
  });

  it("counts more than one unresolved path", () => {
    render(
      <RunResultPanel
        result={result({
          diagnostics: [{ path: "trigger.data.a" }, { path: "nodes.x.data.b" }],
        })}
      />,
    );
    expect(screen.getByText("2 template paths did not resolve")).toBeTruthy();
  });

  it("shows no diagnostics block when every path resolved", () => {
    render(<RunResultPanel result={result({ message: "fine" })} />);
    expect(screen.queryByText(/did not resolve/)).toBeNull();
  });
});
