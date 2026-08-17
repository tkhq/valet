/**
 * The import parser. Every refusal here is a message a person reads, so each
 * case asserts on the message, not only on the failure.
 */
import { describe, expect, it } from "vitest";
import {
  parseWorkflowImport,
  previewWorkflowImport,
  suggestedImportName,
} from "./import-workflow";

const VALID = {
  version: "dag/v1",
  nodes: [
    { id: "trigger", type: "trigger" },
    { id: "notify", type: "tool", service: "slack", action: "send_message", params: {} },
    { id: "stop", type: "stop" },
  ],
  edges: [
    { from: "trigger", to: "notify" },
    { from: "notify", to: "stop" },
  ],
};

describe("parseWorkflowImport", () => {
  it("accepts a bare definition", () => {
    const parsed = parseWorkflowImport(JSON.stringify(VALID));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.name).toBeUndefined();
      expect(parsed.value.definition.nodes).toHaveLength(3);
    }
  });

  it("accepts the API's own workflow response, and keeps its name", () => {
    const parsed = parseWorkflowImport(
      JSON.stringify({
        id: "wf_1",
        name: "Nightly deploy",
        definition: VALID,
        createdAt: 1,
        updatedAt: 2,
        ownerType: "user",
        ownerId: "u-1",
      }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.name).toBe("Nightly deploy");
  });

  it("refuses text that is not JSON", () => {
    const parsed = parseWorkflowImport("not json at all");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors[0]).toContain("not JSON");
  });

  it("refuses JSON that holds no definition, and says what one looks like", () => {
    const parsed = parseWorkflowImport(JSON.stringify({ hello: "world" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors[0]).toContain("version");
      expect(parsed.errors[0]).toContain("nodes");
      expect(parsed.errors[0]).toContain("edges");
    }
  });

  it("returns the validator's messages unaltered for a broken graph", () => {
    const parsed = parseWorkflowImport(
      JSON.stringify({
        version: "dag/v1",
        nodes: [{ id: "trigger", type: "trigger" }],
        edges: [{ from: "trigger", to: "ghost" }],
      }),
    );
    expect(parsed.ok).toBe(false);
    // The node to correct is named — that is the whole reason these come
    // through verbatim instead of as a count.
    if (!parsed.ok) expect(parsed.errors.some((e) => e.includes("ghost"))).toBe(true);
  });

  it("refuses a definition from another product by its version", () => {
    const parsed = parseWorkflowImport(JSON.stringify({ version: "n8n", nodes: [], edges: [] }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.some((e) => e.includes("dag/v1"))).toBe(true);
  });
});

describe("previewWorkflowImport", () => {
  it("counts nodes by type and names every service the workflow calls", () => {
    const parsed = parseWorkflowImport(JSON.stringify(VALID));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const preview = previewWorkflowImport(parsed.value.definition);
    expect(preview.nodeCount).toBe(3);
    expect(preview.services).toEqual(["slack"]);
    expect(preview.nodeTypes.map((n) => n.type).sort()).toEqual(["stop", "tool", "trigger"]);
  });

  it("counts a foreach body's service, because the run executes it", () => {
    const parsed = parseWorkflowImport(
      JSON.stringify({
        version: "dag/v1",
        nodes: [
          { id: "trigger", type: "trigger" },
          {
            id: "each",
            type: "foreach",
            items: "trigger.data.items",
            body: { id: "row", type: "tool", service: "linear", action: "create_issue", params: {} },
          },
          { id: "stop", type: "stop" },
        ],
        edges: [
          { from: "trigger", to: "each" },
          { from: "each", to: "stop" },
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(previewWorkflowImport(parsed.value.definition).services).toEqual(["linear"]);
  });
});

describe("suggestedImportName", () => {
  it("takes the file name without its directory or extension", () => {
    expect(suggestedImportName("workflows/nightly-deploy.json")).toBe("nightly-deploy");
  });

  it("falls back when there is no file name", () => {
    expect(suggestedImportName(undefined)).toBe("Imported workflow");
  });
});
