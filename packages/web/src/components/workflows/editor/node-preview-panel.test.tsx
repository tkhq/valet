// @vitest-environment jsdom
/**
 * NodePreviewPanel tests.
 *
 * Almost every assertion here is about honesty rather than layout: a step
 * that ran and a step that was only described must not read alike, a
 * described step must never show an output value, and a path that resolved
 * to nothing must be visible without expanding anything.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { NodePreviewPanel, parseSampleInput } from "./node-preview-panel";
import type { PreviewNode, PreviewWorkflowResponse } from "@valet/api/wire";

function node(overrides: Partial<PreviewNode> = {}): PreviewNode {
  return {
    nodeId: "build",
    type: "set",
    fidelity: "executed",
    fields: [],
    unresolved: [],
    outputShape: { origin: "known", paths: [] },
    warnings: [],
    ...overrides,
  };
}

function response(overrides: Partial<PreviewWorkflowResponse> = {}): PreviewWorkflowResponse {
  return {
    sample: { kind: "sample_only", fromRun: [], fromPreview: [], inputErrors: [] },
    nodes: [node()],
    ...overrides,
  };
}

function noop() {}

describe("NodePreviewPanel", () => {
  it("marks an executed step as run and shows its real output", () => {
    render(
      <NodePreviewPanel
        status="ready"
        preview={response({
          nodes: [node({ output: { greeting: "Hello a@example.com" } })],
        })}
        onPreview={noop}
      />,
    );
    expect(screen.getByText("Ran")).toBeTruthy();
    expect(screen.getByTestId("preview-output-build").textContent).toContain("Hello a@example.com");
  });

  it("marks a described step as not run and shows no output value", () => {
    render(
      <NodePreviewPanel
        status="ready"
        preview={response({
          nodes: [
            node({
              nodeId: "draft",
              type: "llm",
              fidelity: "described",
              describedReason: "Running this would call claude-haiku-4-5 and bill for it.",
              outputShape: { origin: "known", paths: ["nodes.draft.result.text"] },
            }),
          ],
        })}
        onPreview={noop}
      />,
    );
    expect(screen.getByText("Not run")).toBeTruthy();
    expect(screen.queryByTestId("preview-output-draft")).toBeNull();
    expect(screen.getByTestId("preview-shape-draft").textContent).toContain("would call claude-haiku-4-5");
    expect(screen.getByTestId("preview-shape-draft").textContent).toContain("nodes.draft.result.text");
  });

  it("shows an unresolved path with the keys that were there", () => {
    render(
      <NodePreviewPanel
        status="ready"
        preview={response({
          nodes: [
            node({
              unresolved: [
                {
                  path: "trigger.email",
                  field: "values.typo",
                  resolvedPrefix: "trigger",
                  availableKeys: ["type", "data", "metadata"],
                  message: '"trigger.email" resolved to nothing. Keys at "trigger": type, data, metadata.',
                },
              ],
            }),
          ],
        })}
        onPreview={noop}
      />,
    );
    const unresolved = screen.getByTestId("preview-unresolved").textContent ?? "";
    expect(unresolved).toContain("trigger.email");
    expect(unresolved).toContain("metadata");
  });

  it("distinguishes an empty resolved value from a missing one", () => {
    render(
      <NodePreviewPanel
        status="ready"
        preview={response({
          nodes: [
            node({
              fields: [
                { field: "values.typo", source: "{{trigger.email}}", resolved: null, unresolvedPaths: ["trigger.email"] },
                { field: "values.blank", source: "{{trigger.data.blank}}", resolved: "", unresolvedPaths: [] },
              ],
            }),
          ],
        })}
        onPreview={noop}
      />,
    );
    const fields = screen.getByTestId("preview-fields-build").textContent ?? "";
    expect(fields).toContain("null");
    expect(fields).toContain('""');
  });

  it("names the run the values came from", () => {
    render(
      <NodePreviewPanel
        status="ready"
        preview={response({
          sample: {
            kind: "last_run",
            runId: "wfr_1",
            fromRun: ["draft"],
            fromPreview: ["build"],
            inputErrors: [],
          },
        })}
        onPreview={noop}
      />,
    );
    const summary = screen.getByTestId("preview-sample-summary").textContent ?? "";
    expect(summary).toContain("wfr_1");
    expect(summary).toContain("Computed by this preview: build");
  });

  it("surfaces trigger input that does not satisfy the declared schema", () => {
    render(
      <NodePreviewPanel
        status="ready"
        preview={response({
          sample: {
            kind: "sample_only",
            fromRun: [],
            fromPreview: [],
            inputErrors: [{ field: "email", message: 'Missing required input "email". Provide a value.' }],
          },
        })}
        onPreview={noop}
      />,
    );
    expect(screen.getByTestId("preview-sample-summary").textContent).toContain("Missing required input");
  });

  it("sends the typed sample input and the selected node", () => {
    const onPreview = vi.fn();
    render(<NodePreviewPanel status="idle" nodeId="draft" onPreview={onPreview} />);

    fireEvent.change(screen.getByLabelText("Sample trigger input"), {
      target: { value: '{"email": "a@example.com"}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(onPreview).toHaveBeenCalledWith({ input: { email: "a@example.com" }, nodeId: "draft" });
  });

  it("refuses to send unparseable sample input, and says how to fix it", () => {
    const onPreview = vi.fn();
    render(<NodePreviewPanel status="idle" onPreview={onPreview} />);

    fireEvent.change(screen.getByLabelText("Sample trigger input"), { target: { value: "{oops" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(onPreview).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Fix the JSON");
  });

  it("reports a failed preview", () => {
    render(<NodePreviewPanel status="error" errorText="workflow not found" onPreview={noop} />);
    expect(screen.getByRole("alert").textContent).toContain("workflow not found");
  });
});

describe("parseSampleInput", () => {
  it("reads an empty box as no input", () => {
    expect(parseSampleInput("   ")).toEqual({ input: {} });
  });

  it("reads an object", () => {
    expect(parseSampleInput('{"a": 1}')).toEqual({ input: { a: 1 } });
  });

  it("rejects a JSON array, which is not a trigger payload", () => {
    const result = parseSampleInput("[1, 2]");
    expect("error" in result && result.error).toContain("JSON object");
  });

  it("rejects text that is not JSON", () => {
    const result = parseSampleInput("email = a@example.com");
    expect("error" in result && result.error).toContain("not valid JSON");
  });
});
