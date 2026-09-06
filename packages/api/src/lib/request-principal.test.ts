import { describe, expect, it } from "vitest";
import {
  clientMetadataHasTeamId,
  coerceApiKeyMetadata,
  parseApiKeyMetadata,
  resolveCreateOwner,
  teamApiKeyPathAllowed,
  teamIdFromApiKeyMetadata,
} from "./request-principal.js";

describe("teamIdFromApiKeyMetadata", () => {
  it("reads a non-empty teamId string", () => {
    expect(teamIdFromApiKeyMetadata({ teamId: "team_1", createdBy: "u1" })).toBe("team_1");
  });

  it("ignores a missing, empty, or non-string teamId", () => {
    expect(teamIdFromApiKeyMetadata(null)).toBeUndefined();
    expect(teamIdFromApiKeyMetadata({})).toBeUndefined();
    expect(teamIdFromApiKeyMetadata({ teamId: "" })).toBeUndefined();
    expect(teamIdFromApiKeyMetadata({ teamId: 12 })).toBeUndefined();
  });
});

describe("parseApiKeyMetadata", () => {
  it("parses a JSON object and rejects junk", () => {
    expect(parseApiKeyMetadata('{"teamId":"t1"}')).toEqual({ teamId: "t1" });
    expect(parseApiKeyMetadata("not-json")).toBeNull();
    expect(parseApiKeyMetadata("[1]")).toBeNull();
    expect(parseApiKeyMetadata(null)).toBeNull();
  });

  it("coerces a string or object from verifyApiKey", () => {
    expect(coerceApiKeyMetadata('{"teamId":"t1"}')).toEqual({ teamId: "t1" });
    expect(coerceApiKeyMetadata({ teamId: "t1" })).toEqual({ teamId: "t1" });
    expect(teamIdFromApiKeyMetadata('{"teamId":"t1"}')).toBe("t1");
  });
});

describe("resolveCreateOwner", () => {
  const isMember = async (teamId: string) => teamId === "team_1";

  it("a team principal owns the team even without body.teamId", async () => {
    const result = await resolveCreateOwner({
      principal: { type: "team", id: "team_1" },
      authVia: "apiKey",
      bodyTeamId: undefined,
      userId: "departed-admin",
      isTeamMember: isMember,
    });
    expect(result).toEqual({ ok: true, owner: { type: "team", id: "team_1" } });
  });

  it("a team principal refuses a different teamId", async () => {
    const result = await resolveCreateOwner({
      principal: { type: "team", id: "team_1" },
      authVia: "apiKey",
      bodyTeamId: "team_other",
      userId: "u1",
      isTeamMember: isMember,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
    expect(result.error).toContain("own team");
  });

  it("a personal API key cannot send teamId", async () => {
    const result = await resolveCreateOwner({
      principal: { type: "user", id: "u1" },
      authVia: "apiKey",
      bodyTeamId: "team_1",
      userId: "u1",
      isTeamMember: isMember,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
    expect(result.error).toContain("personal API key");
  });

  it("a cookie session may send teamId when the caller is a member", async () => {
    const result = await resolveCreateOwner({
      principal: { type: "user", id: "u1" },
      authVia: "session",
      bodyTeamId: "team_1",
      userId: "u1",
      isTeamMember: isMember,
    });
    expect(result).toEqual({ ok: true, owner: { type: "team", id: "team_1" } });
  });

  it("a cookie session 404s a team the caller is not on", async () => {
    const result = await resolveCreateOwner({
      principal: { type: "user", id: "u1" },
      authVia: "session",
      bodyTeamId: "team_other",
      userId: "u1",
      isTeamMember: isMember,
    });
    expect(result).toEqual({ ok: false, status: 404, error: "team not found" });
  });

  it("treats teamId: null as personal for a cookie session", async () => {
    const result = await resolveCreateOwner({
      principal: { type: "user", id: "u1" },
      authVia: "stub",
      bodyTeamId: null,
      userId: "u1",
      isTeamMember: isMember,
    });
    expect(result).toEqual({ ok: true, owner: { type: "user", id: "u1" } });
  });
});

describe("clientMetadataHasTeamId", () => {
  it("detects a client stamp and ignores a personal create", () => {
    expect(clientMetadataHasTeamId({ name: "CI", metadata: { teamId: "team_1" } })).toBe(true);
    expect(clientMetadataHasTeamId({ name: "personal" })).toBe(false);
    expect(clientMetadataHasTeamId({ metadata: { note: "x" } })).toBe(false);
  });
});

describe("teamApiKeyPathAllowed", () => {
  it("allows session, workflow, and GET /api/me only", () => {
    expect(teamApiKeyPathAllowed("/api/me", "GET")).toBe(true);
    expect(teamApiKeyPathAllowed("/api/me", "PATCH")).toBe(false);
    expect(teamApiKeyPathAllowed("/api/me/identity-links", "GET")).toBe(false);
    expect(teamApiKeyPathAllowed("/api/sessions", "POST")).toBe(true);
    expect(teamApiKeyPathAllowed("/api/workflows/wf_1/runs", "GET")).toBe(true);
    expect(teamApiKeyPathAllowed("/api/assistants", "POST")).toBe(false);
    expect(teamApiKeyPathAllowed("/api/credentials", "GET")).toBe(false);
    expect(teamApiKeyPathAllowed("/api/org/settings", "PATCH")).toBe(false);
  });
});
