/**
 * Integration tests for `/api/assistants`
 * (`docs/specs/2026-08-13-assistants-design.md`).
 *
 * Two rules the spec sets carry the weight here, and each has its own
 * describe block:
 *
 *   - Promotion is atomic. A principal must never hold zero defaults —
 *     every automation that targets it resolves through the default, and a
 *     principal with none strands every one of them.
 *   - The default cannot be archived while it is the default, and the
 *     refusal names the corrective action.
 *
 * Identities come from `bootTestApi`: `local-user` is an org admin,
 * `test-member` is a plain org member reached with the
 * `x-valet-test-user-id` impersonation header.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "./_setup.js";
import { assistants, teamMembers, teams } from "../schema/index.js";
import type {
  AssistantSummary,
  CreateAssistantResponse,
  ListAssistantsResponse,
  PatchAssistantResponse,
} from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

const MEMBER_HEADERS = { "x-valet-test-user-id": "test-member" };
const JSON_HEADERS = { "Content-Type": "application/json" };

/** POSTs an assistant and returns the created row's wire summary. */
async function create(
  target: TestApi,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<AssistantSummary> {
  const res = await fetch(`${target.baseUrl}/api/assistants`, {
    method: "POST",
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as CreateAssistantResponse;
}

async function list(target: TestApi, query = "", headers: Record<string, string> = {}): Promise<AssistantSummary[]> {
  const res = await fetch(`${target.baseUrl}/api/assistants${query}`, { headers });
  expect(res.status).toBe(200);
  return ((await res.json()) as ListAssistantsResponse).assistants;
}

/** Creates `team_1` in the local org with `userId` on it in `role`. */
async function seedTeam(target: TestApi, userId: string, role: "admin" | "member"): Promise<void> {
  await target.providers.db
    .insert(teams)
    .values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: Date.now() });
  await target.providers.db.insert(teamMembers).values({ teamId: "team_1", userId, role });
}

describe("POST /api/assistants", () => {
  it("the first assistant a principal owns becomes its default", async () => {
    api = await bootTestApi();

    const created = await create(api, { name: "Research" });
    expect(created.id).toMatch(/^asst_/);
    expect(created.sessionId).toBe(`assistant:${created.id}`);
    expect(created.name).toBe("Research");
    expect(created.owner).toEqual({ type: "user", id: "local-user" });
    expect(created.isDefault).toBe(true);
  });

  it("later assistants are not default, and the address is per-assistant", async () => {
    api = await bootTestApi();

    const first = await create(api, { name: "Research" });
    const second = await create(api, { name: "Triage" });

    expect(second.isDefault).toBe(false);
    expect(second.id).not.toBe(first.id);
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it("names are optional — an unnamed assistant carries no name at all", async () => {
    api = await bootTestApi();

    const created = await create(api, {});
    expect(created.name).toBeUndefined();
  });

  it("a team admin creates the team's assistant; a plain member cannot", async () => {
    api = await bootTestApi();
    await seedTeam(api, "test-member", "member");

    // `local-user` is an org admin, which `canAdministerTeam` admits.
    const created = await create(api, { name: "Platform bot", owner: { type: "team", id: "team_1" } });
    expect(created.owner).toEqual({ type: "team", id: "team_1" });

    const refused = await fetch(`${api.baseUrl}/api/assistants`, {
      method: "POST",
      headers: { ...JSON_HEADERS, ...MEMBER_HEADERS },
      body: JSON.stringify({ owner: { type: "team", id: "team_1" } }),
    });
    expect(refused.status).toBe(404);
  });

  it("refuses an owner the caller cannot administer", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/assistants`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ owner: { type: "user", id: "test-member" } }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/assistants", () => {
  it("lists the caller's own assistants, default first", async () => {
    api = await bootTestApi();
    const first = await create(api, { name: "Research" });
    const second = await create(api, { name: "Triage" });

    const rows = await list(api);
    expect(rows.map((r) => r.id)).toEqual([first.id, second.id]);
    expect(rows[0]?.isDefault).toBe(true);
  });

  it("without a filter it also lists the assistants of every team the caller is on", async () => {
    api = await bootTestApi();
    await seedTeam(api, "test-member", "member");
    const mine = await create(api, { name: "Mine" }, MEMBER_HEADERS);
    const teamOwned = await create(api, { name: "Platform bot", owner: { type: "team", id: "team_1" } });

    const rows = await list(api, "", MEMBER_HEADERS);
    expect(rows.map((r) => r.id).sort()).toEqual([mine.id, teamOwned.id].sort());
  });

  it("filters by owner", async () => {
    api = await bootTestApi();
    await seedTeam(api, "local-user", "admin");
    await create(api, { name: "Mine" });
    const teamOwned = await create(api, { name: "Platform bot", owner: { type: "team", id: "team_1" } });

    const rows = await list(api, "?ownerType=team&ownerId=team_1");
    expect(rows.map((r) => r.id)).toEqual([teamOwned.id]);
  });

  it("a non-member cannot list a team's assistants", async () => {
    api = await bootTestApi();
    await seedTeam(api, "local-user", "admin");

    const res = await fetch(`${api.baseUrl}/api/assistants?ownerType=team&ownerId=team_1`, {
      headers: MEMBER_HEADERS,
    });
    expect(res.status).toBe(404);
  });

  it("rejects half an owner filter and says how to fix it", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/assistants?ownerType=team`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("ownerId");
  });

  it("omits archived assistants", async () => {
    api = await bootTestApi();
    await create(api, { name: "Keep" });
    const archived = await create(api, { name: "Drop" });

    const res = await fetch(`${api.baseUrl}/api/assistants/${archived.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const rows = await list(api);
    expect(rows.map((r) => r.id)).not.toContain(archived.id);
  });
});

describe("PATCH /api/assistants/:id — promotion is atomic", () => {
  it("promoting one demotes the previous default in the same write", async () => {
    api = await bootTestApi();
    const first = await create(api, { name: "Research" });
    const second = await create(api, { name: "Triage" });

    const res = await fetch(`${api.baseUrl}/api/assistants/${second.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ isDefault: true }),
    });
    expect(res.status).toBe(200);
    const patched = (await res.json()) as PatchAssistantResponse;
    expect(patched.isDefault).toBe(true);

    const rows = await api.providers.db
      .select()
      .from(assistants)
      .where(eq(assistants.ownerId, "local-user"));
    expect(rows.filter((r) => r.isDefault).map((r) => r.id)).toEqual([second.id]);
    expect(rows.find((r) => r.id === first.id)?.isDefault).toBe(false);
  });

  // The invariant automation depends on: exactly one default at all times,
  // never zero. A principal with no default strands every workflow node,
  // event subscription and channel binding that targets it.
  it("the principal holds exactly one default after every promotion", async () => {
    api = await bootTestApi();
    const first = await create(api, { name: "Research" });
    const second = await create(api, { name: "Triage" });
    const third = await create(api, { name: "Inbox" });

    for (const target of [second.id, third.id, first.id, first.id]) {
      const res = await fetch(`${api.baseUrl}/api/assistants/${target}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ isDefault: true }),
      });
      expect(res.status).toBe(200);

      const defaults = (
        await api.providers.db.select().from(assistants).where(eq(assistants.ownerId, "local-user"))
      ).filter((r) => r.isDefault);
      expect(defaults).toHaveLength(1);
      expect(defaults[0]?.id).toBe(target);
    }
  });

  it("renames without touching the default", async () => {
    api = await bootTestApi();
    const first = await create(api, { name: "Research" });
    const second = await create(api, { name: "Triage" });

    const res = await fetch(`${api.baseUrl}/api/assistants/${second.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(res.status).toBe(200);
    const patched = (await res.json()) as PatchAssistantResponse;
    expect(patched.name).toBe("Renamed");
    expect(patched.isDefault).toBe(false);

    const rows = await api.providers.db.select().from(assistants).where(eq(assistants.id, first.id));
    expect(rows[0]?.isDefault).toBe(true);
  });

  it("refuses a caller who cannot administer the owner", async () => {
    api = await bootTestApi();
    const mine = await create(api, { name: "Research" });

    const res = await fetch(`${api.baseUrl}/api/assistants/${mine.id}`, {
      method: "PATCH",
      headers: { ...JSON_HEADERS, ...MEMBER_HEADERS },
      body: JSON.stringify({ name: "Hijacked" }),
    });
    expect(res.status).toBe(404);
  });

  it("404s an unknown id", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/assistants/asst_nope`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/assistants/:id — archive, not destroy", () => {
  it("archives a non-default assistant and keeps its row", async () => {
    api = await bootTestApi();
    await create(api, { name: "Research" });
    const second = await create(api, { name: "Triage" });

    const res = await fetch(`${api.baseUrl}/api/assistants/${second.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const rows = await api.providers.db.select().from(assistants).where(eq(assistants.id, second.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.archivedAt).not.toBeNull();
  });

  it("refuses to archive the default and names the corrective action", async () => {
    api = await bootTestApi();
    const first = await create(api, { name: "Research" });
    await create(api, { name: "Triage" });

    const res = await fetch(`${api.baseUrl}/api/assistants/${first.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("assistant_is_default");
    expect(body.error).toContain("Promote another assistant to default first");

    const rows = await api.providers.db.select().from(assistants).where(eq(assistants.id, first.id));
    expect(rows[0]?.archivedAt).toBeNull();
    expect(rows[0]?.isDefault).toBe(true);
  });

  it("promoting another first is what makes the archive succeed", async () => {
    api = await bootTestApi();
    const first = await create(api, { name: "Research" });
    const second = await create(api, { name: "Triage" });

    await fetch(`${api.baseUrl}/api/assistants/${second.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ isDefault: true }),
    });
    const res = await fetch(`${api.baseUrl}/api/assistants/${first.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const defaults = (
      await api.providers.db.select().from(assistants).where(eq(assistants.ownerId, "local-user"))
    ).filter((r) => r.isDefault);
    expect(defaults.map((r) => r.id)).toEqual([second.id]);
  });

  it("refuses to promote an archived assistant back to default", async () => {
    api = await bootTestApi();
    await create(api, { name: "Research" });
    const second = await create(api, { name: "Triage" });
    await fetch(`${api.baseUrl}/api/assistants/${second.id}`, { method: "DELETE" });

    const res = await fetch(`${api.baseUrl}/api/assistants/${second.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ isDefault: true }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("assistant_archived");
  });
});

describe("the default assistant is the machine-driven target", () => {
  // `POST /api/orchestrator` resolves the caller's default. Promote a
  // different assistant and the same route must follow the promotion —
  // that is the whole reason the default exists.
  it("POST /api/orchestrator follows the current default", async () => {
    api = await bootTestApi();
    const first = await create(api, { name: "Research" });
    const second = await create(api, { name: "Triage" });

    const before = await fetch(`${api.baseUrl}/api/orchestrator`, { method: "POST" });
    expect(((await before.json()) as { sessionId: string }).sessionId).toBe(first.sessionId);

    await fetch(`${api.baseUrl}/api/assistants/${second.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ isDefault: true }),
    });

    const after = await fetch(`${api.baseUrl}/api/orchestrator`, { method: "POST" });
    expect(((await after.json()) as { sessionId: string }).sessionId).toBe(second.sessionId);
  });

  it("a principal reached before it owned anything gets a default created for it", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/orchestrator`, { method: "POST" });
    expect(res.status).toBe(200);
    const { sessionId } = (await res.json()) as { sessionId: string };

    const rows = await list(api);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isDefault).toBe(true);
    expect(rows[0]?.sessionId).toBe(sessionId);
  });
});

/**
 * The gap this closes: creating an assistant writes only the `assistants`
 * row, and every ordinary session route reads `agent_sessions`. Without an
 * open step a brand-new assistant listed correctly and 404'd on the first
 * click — the feature would have looked finished and failed on use.
 */
describe("POST /api/assistants/:id/session", () => {
  it("makes a newly created assistant openable, which it is not on create alone", async () => {
    api = await bootTestApi();

    const created = (await (
      await fetch(`${api.baseUrl}/api/assistants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Release notes" }),
      })
    ).json()) as AssistantSummary;

    // Create alone leaves no app row, so the session route cannot serve it.
    const beforeOpen = await fetch(
      `${api.baseUrl}/api/sessions/${encodeURIComponent(created.sessionId)}`,
    );
    expect(beforeOpen.status).toBe(404);

    const opened = await fetch(`${api.baseUrl}/api/assistants/${created.id}/session`, {
      method: "POST",
    });
    expect(opened.status).toBe(200);
    expect(((await opened.json()) as { sessionId: string }).sessionId).toBe(created.sessionId);

    const afterOpen = await fetch(
      `${api.baseUrl}/api/sessions/${encodeURIComponent(created.sessionId)}`,
    );
    expect(afterOpen.status).toBe(200);
  });

  it("is idempotent — opening twice returns the same session and adds no row", async () => {
    api = await bootTestApi();
    const created = (await (
      await fetch(`${api.baseUrl}/api/assistants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Twice" }),
      })
    ).json()) as AssistantSummary;

    const first = await fetch(`${api.baseUrl}/api/assistants/${created.id}/session`, { method: "POST" });
    const second = await fetch(`${api.baseUrl}/api/assistants/${created.id}/session`, { method: "POST" });
    expect(await first.json()).toEqual(await second.json());

    const rows = await api.providers.db.select().from(assistants).where(eq(assistants.id, created.id));
    expect(rows).toHaveLength(1);
  });

  it("404s an assistant the caller cannot view", async () => {
    api = await bootTestApi();
    const created = (await (
      await fetch(`${api.baseUrl}/api/assistants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Mine" }),
      })
    ).json()) as AssistantSummary;

    // `local-user` owns it; a different member has no path to it.
    const res = await fetch(`${api.baseUrl}/api/assistants/${created.id}/session`, {
      method: "POST",
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(res.status).toBe(404);
  });
});
