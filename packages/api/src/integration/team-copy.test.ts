import { describe, expect, it } from "vitest";
import { bootTestApi } from "./_setup.js";
import { publishArtifact, getArtifactById } from "../services/artifacts.js";
import { createTeam } from "../services/teams.js";
import { writeFile } from "../services/memory.js";
import { teamMembers, workflowDefinitions } from "../schema/index.js";

describe("team copy HTTP endpoints", () => {
  it("pulls through session auth and rejects malformed requests, collisions and revoked membership", async () => {
    const api = await bootTestApi();
    try {
      const team = await createTeam(api.providers.db, { orgId: "local-org", creatorUserId: "local-user", name: "Source" });
      await writeFile(api.providers.db, { owner: { type: "team", id: team.id }, actorUserId: "local-user" },
        { path: "notes/team.md", content: "Exact team knowledge" });
      const post = (body: string, query = "") => fetch(`${api.baseUrl}/api/memory/copy-from-team${query}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body,
      });
      const body = JSON.stringify({ teamId: team.id, from: "notes/team.md", to: "notes/personal.md" });
      const response = await post(body);
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ file: { ownerType: "user", ownerId: "local-user",
        path: "notes/personal.md", content: "Exact team knowledge", version: 1 } });
      expect((await post(body)).status).toBe(400);
      for (const invalid of ["{", "null", "{}", JSON.stringify({ teamId: "", from: "a.md", to: "b.md" })]) {
        expect((await post(invalid)).status).toBe(400);
      }
      expect((await post(body, "?ownerType=user&ownerId=test-member")).status).toBe(404);
      await api.providers.db.delete(teamMembers);
      expect((await post(body)).status).toBe(404);
    } finally {
      await api.cleanup();
    }
  });

  it("returns a destination workflow ID, rejects conflicts and hides another user's source", async () => {
    const api = await bootTestApi();
    try {
      const team = await createTeam(api.providers.db, { orgId: "local-org", creatorUserId: "local-user", name: "Destination" });
      const definition = { version: "dag/v1", nodes: [{ id: "start", type: "trigger" }], edges: [] };
      await api.providers.db.insert(workflowDefinitions).values([
        { id: "mine", orgId: "local-org", ownerType: "user", ownerId: "local-user", name: "Mine", definition, createdAt: 1, updatedAt: 1 },
        { id: "other", orgId: "local-org", ownerType: "user", ownerId: "test-member", name: "Other", definition, createdAt: 1, updatedAt: 1 },
      ]);
      const post = (id: string, body: string) => fetch(`${api.baseUrl}/api/workflows/${id}/copy-to-team`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body,
      });
      const body = JSON.stringify({ teamId: team.id, name: "Team copy" });
      const response = await post("mine", body);
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ id: expect.any(String), ownerId: team.id, ownerType: "team", definition });
      expect((await post("mine", body)).status).toBe(400);
      expect((await post("other", body)).status).toBe(404);
      expect((await post("mine", "{")).status).toBe(400);
      const source = await publishArtifact(api.providers.db, {
        owner: { type: "user", id: "local-user" }, actorUserId: "local-user",
      }, { key: "source", content: "Exact artifact", format: "markdown", orgId: "local-org" });
      const copyArtifact = () => fetch(`${api.baseUrl}/api/artifacts/copy-to-team`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artifactId: source.id, teamId: team.id, key: "destination" }),
      });
      const artifactResponse = await copyArtifact();
      expect(artifactResponse.status).toBe(201);
      expect(await artifactResponse.json()).toMatchObject({ id: expect.any(String), visibility: "org", path: "destination" });
      expect((await copyArtifact()).status).toBe(400);
      expect(await getArtifactById(api.providers.db, source.id)).toEqual(source);
      const malformedMemory = await fetch(`${api.baseUrl}/api/memory/copy-to-team`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{",
      });
      expect(malformedMemory.status).toBe(400);
    } finally {
      await api.cleanup();
    }
  });
});
