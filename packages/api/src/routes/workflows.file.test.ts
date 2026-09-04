/**
 * `GET /api/workflows/:id/file` — the decision-4 envelope as a download.
 * The YAML has to parse back through `parseWorkflowFileValue` into the same
 * definition. A mirrored workflow writes its upstream reference into
 * `description` and nowhere else.
 */
import { describe, it, expect, afterEach } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseWorkflowFileValue } from "@valet/workflow";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { contentSources, workflowDefinitions } from "../schema/index.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

const VALID_DEFINITION = {
  version: "dag/v1",
  nodes: [
    { id: "trigger", type: "trigger" },
    { id: "stop", type: "stop" },
  ],
  edges: [{ from: "trigger", to: "stop" }],
};

const SOURCE = "src_file_export";
const REPO = "tkhq/automation";
const PATH = ".valet/workflows/nightly.yaml";

async function createWorkflow(baseUrl: string, name = "Nightly triage"): Promise<{ id: string }> {
  const res = await fetch(`${baseUrl}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, definition: VALID_DEFINITION }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

describe("GET /api/workflows/:id/file", () => {
  it("exports YAML that parses back into the same definition", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}/file`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/yaml/);
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="nightly-triage.yaml"',
    );

    const text = await res.text();
    const parsed = parseWorkflowFileValue(parseYaml(text), "nightly-triage.yaml");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.file.kind !== "workflow") return;
    expect(parsed.file.definition).toEqual(VALID_DEFINITION);
    expect(parsed.file.name).toBe("Nightly triage");
  });

  it("404s an unowned workflow", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}/file`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "workflow not found" });
  });

  it("puts a mirrored workflow's upstream reference in description only", async () => {
    api = await bootTestApi();
    const now = Date.now();
    await api.providers.db.insert(contentSources).values({
      id: SOURCE,
      orgId: "local-org",
      ownerType: "user",
      ownerId: "local-user",
      repoFullName: REPO,
      ref: "",
      subpath: "",
      kinds: ["workflows"],
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
    });
    await api.providers.db.insert(workflowDefinitions).values({
      id: "wf_mirrored_export",
      orgId: "local-org",
      ownerType: "user",
      ownerId: "local-user",
      name: "Nightly",
      definition: VALID_DEFINITION,
      origin: "repo",
      sourceId: SOURCE,
      upstreamPath: PATH,
      contentSha: "blob-1",
      createdAt: now,
      updatedAt: now,
    });

    const res = await fetch(`${api.baseUrl}/api/workflows/wf_mirrored_export/file`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="nightly.yaml"');

    const text = await res.text();
    const value = parseYaml(text) as Record<string, unknown>;
    expect(value.description).toBe(`Mirrored from ${REPO}:${PATH}`);
    expect(value).not.toHaveProperty("origin");
    expect(value).not.toHaveProperty("upstream");
    expect(value).not.toHaveProperty("sourceId");
    expect(value).not.toHaveProperty("upstreamPath");

    const parsed = parseWorkflowFileValue(value, PATH);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.file.kind !== "workflow") return;
    expect(parsed.file.definition).toEqual(VALID_DEFINITION);
    expect(parsed.file.description).toBe(`Mirrored from ${REPO}:${PATH}`);
  });

  it("accepts format=json and refuses anything else", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);

    const json = await fetch(`${api.baseUrl}/api/workflows/${created.id}/file?format=json`);
    expect(json.status).toBe(200);
    expect(json.headers.get("content-type")).toMatch(/json/);
    expect(json.headers.get("content-disposition")).toBe(
      'attachment; filename="nightly-triage.json"',
    );
    const value = (await json.json()) as Record<string, unknown>;
    const parsed = parseWorkflowFileValue(value, "nightly-triage.json");
    expect(parsed.ok).toBe(true);

    const bad = await fetch(`${api.baseUrl}/api/workflows/${created.id}/file?format=xml`);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("format must be 'yaml' or 'json'.");
  });
});
