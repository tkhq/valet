/**
 * `/api/prompt-templates` — CRUD + validation tests.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { ListPromptTemplatesResponse, MeResponse } from "../wire/types.js";

const HEADERS = { "Content-Type": "application/json" };

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

describe("GET /api/prompt-templates", () => {
  it("returns an empty list when no templates exist", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/prompt-templates`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListPromptTemplatesResponse;
    expect(body.templates).toEqual([]);
  });
});

describe("PUT /api/prompt-templates/:name", () => {
  it("creates, lists, updates, deletes a template", async () => {
    api = await bootTestApi();

    // Create
    const putRes = await fetch(`${api.baseUrl}/api/prompt-templates/standup`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ description: "Daily standup", content: "Summarize $1" }),
    });
    expect(putRes.status).toBe(200);

    // List shows it
    const listRes = await fetch(`${api.baseUrl}/api/prompt-templates`, { headers: HEADERS });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as ListPromptTemplatesResponse;
    expect(listBody.templates).toEqual([
      { name: "standup", description: "Daily standup", content: "Summarize $1" },
    ]);

    // Update (upsert)
    const updateRes = await fetch(`${api.baseUrl}/api/prompt-templates/standup`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ content: "Updated standup content" }),
    });
    expect(updateRes.status).toBe(200);

    const afterUpdate = await fetch(`${api.baseUrl}/api/prompt-templates`, { headers: HEADERS });
    const afterUpdateBody = (await afterUpdate.json()) as ListPromptTemplatesResponse;
    expect(afterUpdateBody.templates).toHaveLength(1);
    expect(afterUpdateBody.templates[0]?.content).toBe("Updated standup content");

    // Delete
    const delRes = await fetch(`${api.baseUrl}/api/prompt-templates/standup`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(delRes.status).toBe(204);

    // List is empty again
    const afterDel = await fetch(`${api.baseUrl}/api/prompt-templates`, { headers: HEADERS });
    const afterDelBody = (await afterDel.json()) as ListPromptTemplatesResponse;
    expect(afterDelBody.templates).toEqual([]);
  });

  it("rejects names that collide with built-ins", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/prompt-templates/status`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("reserved");
  });

  it("rejects names that do not match the allowed pattern", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/prompt-templates/Bad-Name`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a name starting with a digit", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/prompt-templates/1bad`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing content", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/prompt-templates/mytemplate`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ description: "desc" }),
    });
    expect(res.status).toBe(400);
  });

  it("also rejects other built-in names", async () => {
    api = await bootTestApi();
    for (const name of ["help", "stop", "clear", "model", "compact", "new-thread", "sessions"]) {
      const res = await fetch(`${api.baseUrl}/api/prompt-templates/${name}`, {
        method: "PUT",
        headers: HEADERS,
        body: JSON.stringify({ content: "x" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("reserved");
    }
  });
});

describe("PATCH /api/me bareSkillCommands", () => {
  it("toggles bareSkillCommands and persists on read-back", async () => {
    api = await bootTestApi();

    // Default should be false
    const before = await fetch(`${api.baseUrl}/api/me`, { headers: HEADERS });
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as MeResponse;
    expect(beforeBody.bareSkillCommands).toBe(false);

    // Toggle to true
    const patchRes = await fetch(`${api.baseUrl}/api/me`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ bareSkillCommands: true }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as MeResponse;
    expect(patchBody.bareSkillCommands).toBe(true);

    // Read back via GET
    const after = await fetch(`${api.baseUrl}/api/me`, { headers: HEADERS });
    expect(after.status).toBe(200);
    const afterBody = (await after.json()) as MeResponse;
    expect(afterBody.bareSkillCommands).toBe(true);

    // Toggle back to false
    const patchRes2 = await fetch(`${api.baseUrl}/api/me`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ bareSkillCommands: false }),
    });
    expect(patchRes2.status).toBe(200);
    const patchBody2 = (await patchRes2.json()) as MeResponse;
    expect(patchBody2.bareSkillCommands).toBe(false);
  });

  it("rejects non-boolean bareSkillCommands", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/me`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ bareSkillCommands: "yes" }),
    });
    expect(res.status).toBe(400);
  });
});
