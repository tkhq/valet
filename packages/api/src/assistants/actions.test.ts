/**
 * Agent-facing assistant-profile actions. The suite asserts the properties
 * that make this surface safe to hand to an LLM: every call is scoped to
 * the principal in `ctx`, writes run the same validation the routes run,
 * persona changes evict the cached session (and no-ops do not), and a
 * service error comes back as `success: false` instead of a throw.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginActionContext } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { orgMembers, orgs, users } from "../schema/index.js";
import { addMember, createTeam } from "../services/teams.js";
import { createAssistant } from "./service.js";
import { assistantsActionPlugin } from "./actions.js";

const ORG = "org1";

function ctx(overrides?: { userId?: string; orgId?: string }): PluginActionContext {
  // The actions read `userId`/`orgId` and nothing else; a full ToolContext
  // needs a live sandbox — the same shortcut skills-actions.test.ts takes.
  return {
    userId: "u1",
    orgId: ORG,
    actionId: "assistants.list_assistants",
    service: "assistants",
    ...overrides,
  } as PluginActionContext;
}

async function seedUser(db: AppDb, id: string) {
  await db.insert(users).values({ id, email: `${id}@x.test`, name: id, role: "member" });
  await db.insert(orgMembers).values({ orgId: ORG, userId: id, role: "member" });
}

describe("assistantsActionPlugin", () => {
  let db: AppDb;
  let evict: ReturnType<typeof vi.fn<(sessionId: string) => void>>;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    await db.insert(orgs).values({ id: ORG, name: "Org", createdAt: Date.now() });
    await seedUser(db, "u1");
    await seedUser(db, "u2");
    evict = vi.fn<(sessionId: string) => void>();
  });

  function actionById(id: string) {
    const plugin = assistantsActionPlugin(db, evict);
    const found = plugin.actions.find((a) => a.id === id);
    if (!found) throw new Error(`action missing: ${id}`);
    return found;
  }

  it("exposes exactly the four profile actions under the assistants service", () => {
    const plugin = assistantsActionPlugin(db, evict);
    expect(plugin.service).toBe("assistants");
    expect(plugin.actions.map((a) => a.id).sort()).toEqual([
      "assistants.archive_assistant",
      "assistants.create_assistant",
      "assistants.list_assistants",
      "assistants.update_assistant",
    ]);
  });

  it("gates every write behind a human and leaves the listing open", () => {
    const plugin = assistantsActionPlugin(db, evict);
    const byId = new Map(plugin.actions.map((a) => [a.id, a.riskLevel]));
    expect(byId.get("assistants.list_assistants")).toBe("low");
    // High → the catalog's default policy asks a human first. A personality
    // or behavior config is standing instruction text every later wake
    // injects — the same reasoning that keeps skills.create_skill at high.
    expect(byId.get("assistants.create_assistant")).toBe("high");
    expect(byId.get("assistants.update_assistant")).toBe("high");
    expect(byId.get("assistants.archive_assistant")).toBe("high");
  });

  it("lists own and team assistants, never another user's personal ones", async () => {
    const team = await createTeam(db, { orgId: ORG, name: "Security", creatorUserId: "u2" });
    await addMember(db, { teamId: team.id, userId: "u1", role: "member" });
    await createAssistant(db, ORG, { type: "user", id: "u1" }, "Mine");
    await createAssistant(db, ORG, { type: "user", id: "u2" }, "Theirs");
    await createAssistant(db, ORG, { type: "team", id: team.id }, "Ours");

    const result = await actionById("assistants.list_assistants").execute({}, ctx());
    expect(result.success).toBe(true);
    const names = (result.data as { assistants: { name?: string }[] }).assistants.map((a) => a.name);
    expect(names.sort()).toEqual(["Mine", "Ours"]);
  });

  it("creates for a team only when the caller administers it", async () => {
    const team = await createTeam(db, { orgId: ORG, name: "Security", creatorUserId: "u2" });
    await addMember(db, { teamId: team.id, userId: "u1", role: "member" });

    const create = actionById("assistants.create_assistant");
    const denied = await create.execute({ name: "Sentinel", team_id: team.id }, ctx());
    expect(denied.success).toBe(false);
    expect(denied.error).toContain("owner not found");

    const allowed = await create.execute(
      { name: "Sentinel", team_id: team.id },
      ctx({ userId: "u2" }),
    );
    expect(allowed.success).toBe(true);
    expect((allowed.data as { owner: { type: string } }).owner.type).toBe("team");
  });

  it("update changes persona inputs and evicts; a no-op write does not evict", async () => {
    const row = await createAssistant(db, ORG, { type: "user", id: "u1" }, "Wren");
    const update = actionById("assistants.update_assistant");

    const changed = await update.execute(
      { assistant_id: row.id, personality: "Blunt." },
      ctx(),
    );
    expect(changed.success).toBe(true);
    expect(evict).toHaveBeenCalledWith(row.sessionId);

    evict.mockClear();
    const noop = await update.execute(
      { assistant_id: row.id, personality: "Blunt." },
      ctx(),
    );
    expect(noop.success).toBe(true);
    expect(evict).not.toHaveBeenCalled();
  });

  it("update clears personality with null (explicit clear, not the file fallback)", async () => {
    const row = await createAssistant(db, ORG, { type: "user", id: "u1" }, "Wren", {
      personality: "Blunt.",
    });
    const result = await actionById("assistants.update_assistant").execute(
      { assistant_id: row.id, personality: null },
      ctx(),
    );
    expect(result.success).toBe(true);
    expect((result.data as { personality?: string }).personality).toBe("");
  });

  it("update rejects a malformed behavior with the validator's corrective message", async () => {
    const row = await createAssistant(db, ORG, { type: "user", id: "u1" }, "Wren");
    const result = await actionById("assistants.update_assistant").execute(
      { assistant_id: row.id, behavior: { skills: { mode: "some" } } },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/skills\.mode must be 'all' or 'allowlist'/);
    expect(evict).not.toHaveBeenCalled();
  });

  it("update hides another user's assistant (existence-hiding)", async () => {
    const row = await createAssistant(db, ORG, { type: "user", id: "u2" }, "Theirs");
    const result = await actionById("assistants.update_assistant").execute(
      { assistant_id: row.id, name: "Hijacked" },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("assistant not found");
  });

  it("is_default promotes and demotes in one write", async () => {
    const first = await createAssistant(db, ORG, { type: "user", id: "u1" }, "First");
    const second = await createAssistant(db, ORG, { type: "user", id: "u1" }, "Second");
    expect(first.isDefault).toBe(true);

    const result = await actionById("assistants.update_assistant").execute(
      { assistant_id: second.id, is_default: true },
      ctx(),
    );
    expect(result.success).toBe(true);
    const listed = await actionById("assistants.list_assistants").execute({}, ctx());
    const byName = new Map(
      (listed.data as { assistants: { name?: string; isDefault: boolean }[] }).assistants.map(
        (a) => [a.name, a.isDefault],
      ),
    );
    expect(byName.get("Second")).toBe(true);
    expect(byName.get("First")).toBe(false);
  });

  it("archive protects the default and archives the rest", async () => {
    const first = await createAssistant(db, ORG, { type: "user", id: "u1" }, "First");
    const second = await createAssistant(db, ORG, { type: "user", id: "u1" }, "Second");
    const archive = actionById("assistants.archive_assistant");

    const denied = await archive.execute({ assistant_id: first.id }, ctx());
    expect(denied.success).toBe(false);
    expect(denied.error).toMatch(/default/i);

    const ok = await archive.execute({ assistant_id: second.id }, ctx());
    expect(ok.success).toBe(true);

    const listed = await actionById("assistants.list_assistants").execute({}, ctx());
    const names = (listed.data as { assistants: { name?: string }[] }).assistants.map((a) => a.name);
    expect(names).toEqual(["First"]);
  });
});
