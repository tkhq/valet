/**
 * `PATCH /api/teams/:id` — team settings (TKAI-255): the team default
 * model. Gating matches the other team mutations (`canAdministerTeam`:
 * team admin of that team, or org admin), and validation matches
 * `PATCH /api/me`'s `defaultModel` (org-catalog id set, null clears).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { teamMembers, teams } from "../schema/index.js";
import type { ListTeamsResponse, PatchTeamResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  await api?.cleanup();
  api = undefined;
});

/** One team: `test-lead` is its team admin, `test-member` a plain member.
 * The stub identity `local-user` is an org admin who is NOT on the team. */
async function seedTeam(target: TestApi): Promise<void> {
  await target.providers.db
    .insert(teams)
    .values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: Date.now() });
  await target.providers.db.insert(teamMembers).values([
    { teamId: "team_1", userId: "test-lead", role: "admin" },
    { teamId: "team_1", userId: "test-member", role: "member" },
  ]);
}

async function patchTeam(
  target: TestApi,
  body: unknown,
  asUser?: string,
): Promise<Response> {
  return fetch(`${target.baseUrl}/api/teams/team_1`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...(asUser ? { "x-valet-test-user-id": asUser } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/teams/:id", () => {
  it("team admin sets the default model; GET /api/teams reflects it", async () => {
    // The catalog reports an Anthropic entry as valid only when a key
    // exists (zero-config env fallback), same as me.test.ts.
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-stub");
    api = await bootTestApi();
    await seedTeam(api);

    const res = await patchTeam(api, { defaultModel: "anthropic/claude-sonnet-4-5" }, "test-lead");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PatchTeamResponse;
    expect(body.team.defaultModel).toBe("anthropic/claude-sonnet-4-5");

    const listRes = await fetch(`${api.baseUrl}/api/teams`, {
      headers: { "x-valet-test-user-id": "test-lead" },
    });
    const list = (await listRes.json()) as ListTeamsResponse;
    expect(list.teams.find((t) => t.id === "team_1")?.defaultModel).toBe(
      "anthropic/claude-sonnet-4-5",
    );
  });

  it("null clears the override", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-stub");
    api = await bootTestApi();
    await seedTeam(api);
    await patchTeam(api, { defaultModel: "anthropic/claude-sonnet-4-5" }, "test-lead");

    const res = await patchTeam(api, { defaultModel: null }, "test-lead");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PatchTeamResponse;
    expect(body.team.defaultModel).toBeNull();
  });

  it("org admin who is not on the team can set it (recovery path)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-stub");
    api = await bootTestApi();
    await seedTeam(api);

    // The default stub identity `local-user` is the org admin.
    const res = await patchTeam(api, { defaultModel: "anthropic/claude-sonnet-4-5" });
    expect(res.status).toBe(200);
  });

  it("plain team member gets 404 (existence-hiding, same as other mutations)", async () => {
    api = await bootTestApi();
    await seedTeam(api);

    const res = await patchTeam(api, { defaultModel: "anthropic/claude-sonnet-4-5" }, "test-member");
    expect(res.status).toBe(404);
  });

  it("unknown model id 400s and names the fix", async () => {
    api = await bootTestApi();
    await seedTeam(api);

    const res = await patchTeam(api, { defaultModel: "not-a-real-model" }, "test-lead");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/GET \/api\/models/);
  });

  it("non-string non-null defaultModel 400s", async () => {
    api = await bootTestApi();
    await seedTeam(api);

    const res = await patchTeam(api, { defaultModel: 42 }, "test-lead");
    expect(res.status).toBe(400);
  });

  it("JSON-valid non-object bodies 400 instead of 500", async () => {
    api = await bootTestApi();
    await seedTeam(api);

    for (const body of [null, 42, true, "x", []]) {
      const res = await patchTeam(api, body, "test-lead");
      expect(res.status).toBe(400);
      const parsed = (await res.json()) as { error: string };
      expect(parsed.error).toMatch(/JSON object/);
    }
  });

  it("unknown field 400s rather than silently no-oping", async () => {
    api = await bootTestApi();
    await seedTeam(api);

    const res = await patchTeam(api, { name: "Renamed" }, "test-lead");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unknown field/);
  });
});
