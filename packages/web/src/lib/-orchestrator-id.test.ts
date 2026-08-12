/**
 * These two functions mirror `orchestratorSessionId` /
 * `parseOrchestratorSessionId` in `packages/engine/src/principal.ts`. The
 * round-trip cases below are what keep the mirror honest — if the engine
 * ever changes the id format, these fail before the rail links anywhere
 * wrong.
 */
import { describe, expect, it } from "vitest";
import { parseTeamOrchestratorId, teamOrchestratorSessionId } from "./orchestrator-id";

describe("teamOrchestratorSessionId", () => {
  it("builds the engine's well-known team orchestrator id", () => {
    expect(teamOrchestratorSessionId("team_1")).toBe("orchestrator:team:team_1");
  });
});

describe("parseTeamOrchestratorId", () => {
  it("round-trips a team id", () => {
    const id = teamOrchestratorSessionId("team_abc");
    expect(parseTeamOrchestratorId(id)).toBe("team_abc");
  });

  it("returns null for a user's own orchestrator — it is not team-owned", () => {
    expect(parseTeamOrchestratorId("orchestrator:user:u1")).toBeNull();
  });

  it("returns null for an org orchestrator", () => {
    expect(parseTeamOrchestratorId("orchestrator:org:org_1")).toBeNull();
  });

  it("returns null for a plain session id", () => {
    expect(parseTeamOrchestratorId("sess_123")).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(parseTeamOrchestratorId("")).toBeNull();
    expect(parseTeamOrchestratorId("orchestrator")).toBeNull();
    expect(parseTeamOrchestratorId("orchestrator:team")).toBeNull();
    expect(parseTeamOrchestratorId("orchestrator:team:")).toBeNull();
  });

  it("keeps a colon inside the team id, matching the engine's parser", () => {
    expect(parseTeamOrchestratorId("orchestrator:team:a:b")).toBe("a:b");
  });
});
