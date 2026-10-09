/**
 * Which personality a workspace's prompt opens with when an upgraded
 * database holds both the carried-over `assistants.personality` column and
 * the `assistant/personality.md` memory file (`assistants/legacy-profile.ts`).
 * Before the workspace runtime, a set column won over the file and an empty
 * column meant an explicitly neutral persona. That stays true until the file
 * is edited after the upgrade; a later edit wins.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Principal } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { ensureDefaultAssistantSession, resolveDefaultAssistant } from "../assistants/service.js";
import { writeFile } from "../services/memory.js";

const ORG = "local-org";
const COLUMN = "Answer in one short paragraph.";
const FILE = "Use bullet lists and cite sources.";

describe("carried-over personality in the workspace prompt", () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await bootTestApi({ plugins: [] });
    await api.providers.db.execute(sql`ALTER TABLE assistants ADD COLUMN IF NOT EXISTS name text,
      ADD COLUMN IF NOT EXISTS avatar_url text, ADD COLUMN IF NOT EXISTS personality text`);
  });

  afterAll(async () => {
    await api?.cleanup();
  });

  /** One personal workspace per case, so each builds its own session. */
  async function promptFor(
    userId: string,
    legacy: { name: string | null; personality: string | null },
    file?: { content: string; editedAfterUpgrade: boolean },
  ): Promise<string> {
    const { db, engineHost } = api.providers;
    const owner: Principal = { type: "user", id: userId };
    const row = await resolveDefaultAssistant(db, ORG, owner);
    await db.execute(sql`UPDATE assistants SET name = ${legacy.name}, personality = ${legacy.personality} WHERE id = ${row.id}`);
    if (file) {
      await writeFile(db, { owner, actorUserId: userId }, { path: "assistant/personality.md", content: file.content });
      if (!file.editedAfterUpgrade) {
        // A file last written before the upgrade marker, as on an upgraded database.
        await db.execute(sql`UPDATE memory_files SET updated_at = (SELECT applied_at - 60000
            FROM __valet_app_migrations WHERE filename = 'legacy-runtime-continuity-v1')
          WHERE owner_type = 'user' AND owner_id = ${userId} AND path = 'assistant/personality.md'`);
      }
    }
    const { session } = await ensureDefaultAssistantSession({ db, engineHost }, owner, { actorUserId: userId, orgId: ORG });
    return session.options.systemPrompt ?? "";
  }

  it("uses the column when there is no memory file", async () => {
    const prompt = await promptFor("persona-column", { name: "Desk Helper", personality: COLUMN });
    expect(prompt.startsWith(`You are Desk Helper. ${COLUMN}\n\n`)).toBe(true);
  });

  it("uses the memory file when the column was never set", async () => {
    const prompt = await promptFor("persona-file", { name: null, personality: null }, { content: FILE, editedAfterUpgrade: false });
    expect(prompt.startsWith(`${FILE}\n\n`)).toBe(true);
  });

  it("keeps the column over a file nobody edited since the upgrade", async () => {
    const prompt = await promptFor("persona-both-old", { name: "Desk Helper", personality: COLUMN }, { content: FILE, editedAfterUpgrade: false });
    expect(prompt.startsWith(`You are Desk Helper. ${COLUMN}\n\n`)).toBe(true);
    expect(prompt).not.toContain(FILE);
  });

  it("uses a file edited after the upgrade over the column", async () => {
    const prompt = await promptFor("persona-both-new", { name: "Desk Helper", personality: COLUMN }, { content: FILE, editedAfterUpgrade: true });
    expect(prompt.startsWith(`You are Desk Helper. ${FILE}\n\n`)).toBe(true);
    expect(prompt).not.toContain(COLUMN);
  });

  it("keeps an emptied column neutral over a file nobody edited since the upgrade", async () => {
    const prompt = await promptFor("persona-neutral", { name: "Desk Helper", personality: "" }, { content: FILE, editedAfterUpgrade: false });
    expect(prompt.startsWith("You are Desk Helper.\n\n")).toBe(true);
    expect(prompt).not.toContain(FILE);
  });

  it("uses a file edited after the upgrade over an emptied column", async () => {
    const prompt = await promptFor("persona-neutral-new", { name: null, personality: "" }, { content: FILE, editedAfterUpgrade: true });
    expect(prompt.startsWith(`${FILE}\n\n`)).toBe(true);
  });
});
