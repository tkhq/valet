/**
 * The import parser. Every refusal here is a message a person reads, so each
 * case asserts on the message, not only on the failure.
 *
 * The shapes themselves are `@valet/workflow`'s `parseWorkflowFileValue`,
 * covered in that package's own suite. What is covered here is the decoder
 * this module adds: JSON first, then the YAML chunk.
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
  it("accepts a bare definition", async () => {
    const parsed = await parseWorkflowImport(JSON.stringify(VALID));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.name).toBeUndefined();
      expect(parsed.value.definition.nodes).toHaveLength(3);
    }
  });

  it("accepts the API's own workflow response, and keeps its name", async () => {
    const parsed = await parseWorkflowImport(
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

  it("accepts a pasted YAML envelope, comments and all", async () => {
    // The shape the repository sync reads. A hand-authored file wants
    // comments and multi-line text, which is why YAML is the documented
    // default — and why the dialog has to read one.
    const parsed = await parseWorkflowImport(
      [
        "# The nightly sweep.",
        "valet: workflow/v1",
        "name: Nightly triage",
        "description: Sweeps open issues.",
        "definition:",
        "  version: dag/v1",
        "  nodes:",
        "    - id: trigger",
        "      type: trigger",
        "    - id: notify",
        "      type: tool",
        "      service: slack",
        "      action: send_message",
        "      params: {}",
        "  edges:",
        "    - from: trigger",
        "      to: notify",
        "",
      ].join("\n"),
      "nightly.yaml",
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.name).toBe("Nightly triage");
    expect(parsed.value.definition.nodes).toHaveLength(2);
  });

  it("names the envelope blocks the import does not create", async () => {
    // `POST /api/workflows` writes a name and a definition. A schedule, an
    // event trigger and a description have nowhere to land, and a file whose
    // schedule is dropped in silence imports as a workflow that never runs.
    const parsed = await parseWorkflowImport(
      [
        "valet: workflow/v1",
        "name: Nightly triage",
        "description: Sweeps open issues.",
        "schedule:",
        '  cron: "0 3 * * *"',
        "events:",
        "  - name: On push",
        "    eventKeys: [github.push]",
        "definition:",
        "  version: dag/v1",
        "  nodes:",
        "    - id: trigger",
        "      type: trigger",
        "  edges: []",
        "",
      ].join("\n"),
      "nightly.yaml",
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.skipped).toEqual(["a schedule", "an event trigger", "a description"]);
  });

  it("has nothing to skip when the file carries a definition alone", async () => {
    const parsed = await parseWorkflowImport(JSON.stringify(VALID));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.skipped).toEqual([]);
  });

  it("refuses text that is neither JSON nor YAML", async () => {
    // Unbalanced brackets are the shape no decoder can read. Plain prose is
    // a valid YAML scalar, and it is refused a line later for holding no
    // definition rather than for failing to parse.
    const parsed = await parseWorkflowImport("{ nodes: [ ");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors[0]).toContain("neither JSON nor YAML");
  });

  it("refuses a file that holds no definition, and says what one looks like", async () => {
    const parsed = await parseWorkflowImport(JSON.stringify({ hello: "world" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors[0]).toContain("version");
      expect(parsed.errors[0]).toContain("nodes");
      expect(parsed.errors[0]).toContain("edges");
    }
  });

  it("names the file it refused, so a wrong upload is obvious", async () => {
    const parsed = await parseWorkflowImport("just some prose", "notes.yaml");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors[0]).toContain("notes.yaml");
  });

  it("returns the validator's messages unaltered for a broken graph", async () => {
    const parsed = await parseWorkflowImport(
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

  it("refuses a definition from another product by its version", async () => {
    const parsed = await parseWorkflowImport(
      JSON.stringify({ version: "n8n", nodes: [], edges: [] }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.some((e) => e.includes("dag/v1"))).toBe(true);
  });

  it("names the kinds it reads when a file claims an unknown one", async () => {
    const parsed = await parseWorkflowImport(
      JSON.stringify({ valet: "workflow/v2", definition: VALID }),
      "future.yaml",
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors[0]).toContain("workflow/v1");
  });
});

describe("previewWorkflowImport", () => {
  it("counts nodes by type and names every service the workflow calls", async () => {
    const parsed = await parseWorkflowImport(JSON.stringify(VALID));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const preview = previewWorkflowImport(parsed.value.definition);
    expect(preview.nodeCount).toBe(3);
    expect(preview.services).toEqual(["slack"]);
    expect(preview.nodeTypes.map((n) => n.type).sort()).toEqual(["stop", "tool", "trigger"]);
  });

  it("counts a foreach body's service, because the run executes it", async () => {
    const parsed = await parseWorkflowImport(
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

  it("strips a YAML extension too, now that the sync reads one", () => {
    expect(suggestedImportName(".valet/workflows/nightly-deploy.yaml")).toBe("nightly-deploy");
    expect(suggestedImportName(".valet/workflows/nightly-deploy.yml")).toBe("nightly-deploy");
  });

  it("falls back when there is no file name", () => {
    expect(suggestedImportName(undefined)).toBe("Imported workflow");
  });
});
