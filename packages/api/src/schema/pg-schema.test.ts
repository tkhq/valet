/**
 * Task 6 exit test: the pg app schema (`index.pg.ts`) + migrations
 * (`migrations/pg/0000_app.sql`) + async migration runner (`lib/drizzle-pg.ts`)
 * boot cleanly against PGlite, every table lands, the `memory_files`
 * tsvector generated column round-trips a `websearch_to_tsquery` search with
 * the weight ordering spec decision 9 requires, and a real `betterAuth()`
 * instance mounted over the regenerated pg block can complete a signup.
 *
 * Nothing else in the repo imports `index.pg.ts`/`drizzle-pg.ts` yet (Task 7
 * does the cutover) — this file is the only consumer, and intentionally so.
 */
import { PGlite } from "@electric-sql/pglite";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgDbFromPglite, type PgDb } from "@valet/store-postgres";
import { applyAppMigrations, buildAppDb as buildAppPgDb } from "../lib/drizzle.js";
import {
  users,
  session,
  account,
  verification,
  ssoProvider,
  apikey,
  oauthApplication,
  oauthAccessToken,
  oauthConsent,
  memoryFiles,
  llmProviders,
  orgs,
  agentSessions,
  sessionRepos,
  githubInstallations,
  events,
  linearInstallations,
} from "./index.js";

const APP_TABLES = [
  "orgs",
  "user",
  "session",
  "account",
  "verification",
  "sso_provider",
  "apikey",
  "oauth_application",
  "oauth_access_token",
  "oauth_consent",
  "invites",
  "sandbox_tokens",
  "org_members",
  "agent_sessions",
  "session_threads",
  "messages",
  "teams",
  "team_members",
  "assistants",
  "child_watches",
  "notifications",
  "user_notification_preferences",
  "event_drop_log",
  "channel_bindings",
  "user_identity_links",
  "memory_files",
  "workflow_definitions",
  "workflow_runs",
  "workflow_checkpoints",
  "workflow_signals",
  "credentials",
  "action_invocations",
  "llm_providers",
  "session_repos",
  "github_installations",
  "events",
  "event_subscriptions",
  "event_deliveries",
  "linear_installations",
];

async function tableExists(db: PgDb, table: string): Promise<boolean> {
  const result = await db.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1",
    [table],
  );
  return result.rows.length > 0;
}

describe("pg app schema + migrations", () => {
  // Task 0 finding (docs/specs/2026-07-15-postgres-backend-design.md): PGlite's
  // wasm heap isn't reliably released on close(), so this file shares ONE
  // instance across all its tests/describe blocks.
  const pglite = new PGlite();
  const db = pgDbFromPglite(pglite);
  const drizzleDb = buildAppPgDb(pglite);

  beforeAll(async () => {
    await applyAppMigrations(db);
  });

  afterAll(async () => {
    await db.close();
  });

  it(`creates all ${APP_TABLES.length} app tables`, async () => {
    for (const table of APP_TABLES) {
      expect(await tableExists(db, table), `expected table ${table} to exist`).toBe(true);
    }
  });

  it("tracks the applied migration in __valet_app_migrations", async () => {
    const result = await db.query("SELECT filename FROM __valet_app_migrations WHERE filename = $1", [
      "0000_app.sql",
    ]);
    expect(result.rows).toHaveLength(1);
  });

  it("is idempotent on re-run", async () => {
    await expect(applyAppMigrations(db)).resolves.toBeUndefined();
    for (const table of APP_TABLES) {
      expect(await tableExists(db, table)).toBe(true);
    }
  });

  // The `cost_entries` view joins `engine_entries` (engine schema) to
  // `agent_sessions`/`workflow_runs`/`workflow_definitions` (app schema), so
  // the app migration only applies after the engine migration.
  // `applyAppMigrations` owns that ordering — this caller never applies the
  // engine schema itself. See `cost-entries-view.test.ts` for the view's
  // owner-resolution behavior.
  it("creates the cross-schema cost_entries view without a separate engine-migration call", async () => {
    const result = await db.query(
      "SELECT 1 FROM information_schema.views WHERE table_schema = current_schema() AND table_name = 'cost_entries'",
    );
    expect(result.rows).toHaveLength(1);
  });

  it("workflow_signals.id is a generated-always identity column", async () => {
    const col = await db.query(
      "SELECT is_identity, identity_generation FROM information_schema.columns " +
        "WHERE table_name = 'workflow_signals' AND column_name = 'id'",
    );
    expect(col.rows[0]).toEqual({ is_identity: "YES", identity_generation: "ALWAYS" });
  });

  describe("memory_files search_vector generated column (spec decision 9)", () => {
    const now = Date.now();

    beforeAll(async () => {
      // A title-relevance doc: the term appears ONLY in the title (weight A).
      await drizzleDb.insert(memoryFiles).values({
        ownerType: "user",
        ownerId: "u1",
        path: "notes/xylophone.md",
        title: "Xylophone maintenance guide",
        content: "This document covers general instrument upkeep.",
        description: "",
        tags: "[]",
        createdAt: now,
        updatedAt: now,
      });
      // A content-relevance doc: the SAME term appears only deep in the body
      // (weight D), title/description/tags are unrelated.
      await drizzleDb.insert(memoryFiles).values({
        ownerType: "user",
        ownerId: "u1",
        path: "notes/unrelated.md",
        title: "Weekly journal",
        content: "Today I practiced piano and briefly mentioned a xylophone in passing.",
        description: "",
        tags: "[]",
        createdAt: now,
        updatedAt: now,
      });
      // A path-relevance doc: the term appears in the path (weight C) and
      // content (weight D), but NOT the title — must still outrank a
      // content-only match (decision 9's adversarial-review catch: path
      // must not collapse into content's weight class).
      await drizzleDb.insert(memoryFiles).values({
        ownerType: "user",
        ownerId: "u1",
        path: "instruments/xylophone/setup.md",
        title: "Setup",
        content: "Generic setup instructions mentioning a xylophone once.",
        description: "",
        tags: "[]",
        createdAt: now,
        updatedAt: now,
      });
    });

    it("websearch_to_tsquery matches all three docs containing the term", async () => {
      const result = await db.query(
        `SELECT path FROM memory_files WHERE search_vector @@ websearch_to_tsquery('english', $1) ORDER BY path`,
        ["xylophone"],
      );
      expect(result.rows.map((r) => r.path)).toEqual([
        "instruments/xylophone/setup.md",
        "notes/unrelated.md",
        "notes/xylophone.md",
      ]);
    });

    it("ts_rank_cd ranks a title match above a content-only match", async () => {
      const result = await db.query(
        `SELECT path, ts_rank_cd(search_vector, websearch_to_tsquery('english', $1)) AS rank
         FROM memory_files
         WHERE search_vector @@ websearch_to_tsquery('english', $1)
           AND path IN ('notes/xylophone.md', 'notes/unrelated.md')
         ORDER BY rank DESC`,
        ["xylophone"],
      );
      expect(result.rows.map((r) => r.path)).toEqual(["notes/xylophone.md", "notes/unrelated.md"]);
    });

    it("ts_rank_cd ranks a path match above a content-only match", async () => {
      const result = await db.query(
        `SELECT path, ts_rank_cd(search_vector, websearch_to_tsquery('english', $1)) AS rank
         FROM memory_files
         WHERE search_vector @@ websearch_to_tsquery('english', $1)
           AND path IN ('instruments/xylophone/setup.md', 'notes/unrelated.md')
         ORDER BY rank DESC`,
        ["xylophone"],
      );
      expect(result.rows.map((r) => r.path)).toEqual([
        "instruments/xylophone/setup.md",
        "notes/unrelated.md",
      ]);
    });
  });

  describe("llm_providers", () => {
    const now = Date.now();

    it("round-trips an insert/select incl. jsonb models shape", async () => {
      await drizzleDb.insert(orgs).values({ id: "org-llm-1", name: "Org LLM", createdAt: now });
      await drizzleDb.insert(llmProviders).values({
        id: "prov_1",
        orgId: "org-llm-1",
        kind: "openai_compatible",
        name: "Local vLLM",
        baseUrl: "http://localhost:8000/v1",
        enabled: true,
        models: [{ id: "llama-3", name: "Llama 3", contextWindow: 8192 }],
        createdAt: now,
      });

      const rows = await drizzleDb.select().from(llmProviders).where(eq(llmProviders.id, "prov_1"));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        id: "prov_1",
        orgId: "org-llm-1",
        kind: "openai_compatible",
        name: "Local vLLM",
        baseUrl: "http://localhost:8000/v1",
        enabled: true,
        models: [{ id: "llama-3", name: "Llama 3", contextWindow: 8192 }],
        createdAt: now,
      });
    });

    it("enforces one row per known kind per org via the partial unique index", async () => {
      await drizzleDb.insert(orgs).values({ id: "org-llm-2", name: "Org LLM 2", createdAt: now });
      await drizzleDb.insert(llmProviders).values({
        id: "prov_2",
        orgId: "org-llm-2",
        kind: "anthropic",
        name: "Anthropic",
        enabled: true,
        models: [],
        createdAt: now,
      });

      await expect(
        drizzleDb.insert(llmProviders).values({
          id: "prov_3",
          orgId: "org-llm-2",
          kind: "anthropic",
          name: "Anthropic dupe",
          enabled: true,
          models: [],
          createdAt: now,
        }),
      ).rejects.toThrow();

      // openai_compatible is exempt from the singleton constraint.
      await drizzleDb.insert(llmProviders).values({
        id: "prov_4",
        orgId: "org-llm-2",
        kind: "openai_compatible",
        name: "Custom A",
        enabled: true,
        models: [],
        createdAt: now,
      });
      await drizzleDb.insert(llmProviders).values({
        id: "prov_5",
        orgId: "org-llm-2",
        kind: "openai_compatible",
        name: "Custom B",
        enabled: true,
        models: [],
        createdAt: now,
      });
    });
  });

  describe("session_repos", () => {
    const now = Date.now();

    it("round-trips a per-position insert/select with the position uniqueness index", async () => {
      await drizzleDb.insert(agentSessions).values({
        id: "sess-repo-1",
        userId: "u1",
        orgId: "org-repo-1",
        workspace: "/tmp/sess-repo-1",
        status: "active",
        ownerType: "user",
        ownerId: "u1",
        profile: "headless",
        createdAt: now,
        updatedAt: now,
      });
      await drizzleDb.insert(sessionRepos).values([
        {
          sessionId: "sess-repo-1",
          host: "github",
          fullName: "acme/widgets",
          cloneUrl: "https://github.com/acme/widgets.git",
          ref: "main",
          auth: "auto",
          position: 0,
        },
        {
          sessionId: "sess-repo-1",
          host: "github",
          fullName: "acme/sprockets",
          cloneUrl: "https://github.com/acme/sprockets.git",
          auth: "app",
          position: 1,
        },
      ]);

      const rows = await drizzleDb
        .select()
        .from(sessionRepos)
        .where(eq(sessionRepos.sessionId, "sess-repo-1"))
        .orderBy(sessionRepos.position);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        sessionId: "sess-repo-1",
        host: "github",
        fullName: "acme/widgets",
        cloneUrl: "https://github.com/acme/widgets.git",
        ref: "main",
        auth: "auto",
        position: 0,
        targetDir: null,
      });
      expect(rows[1]?.fullName).toBe("acme/sprockets");
      expect(rows[1]?.ref).toBeNull();
      expect(rows[1]?.auth).toBe("app");
    });

    it("rejects a duplicate (session_id, position) pair", async () => {
      await drizzleDb.insert(agentSessions).values({
        id: "sess-repo-2",
        userId: "u1",
        orgId: "org-repo-2",
        workspace: "/tmp/sess-repo-2",
        status: "active",
        ownerType: "user",
        ownerId: "u1",
        profile: "headless",
        createdAt: now,
        updatedAt: now,
      });
      await drizzleDb.insert(sessionRepos).values({
        sessionId: "sess-repo-2",
        fullName: "acme/widgets",
        cloneUrl: "https://github.com/acme/widgets.git",
        position: 0,
      });

      await expect(
        drizzleDb.insert(sessionRepos).values({
          sessionId: "sess-repo-2",
          fullName: "acme/other",
          cloneUrl: "https://github.com/acme/other.git",
          position: 0,
        }),
      ).rejects.toThrow();
    });
  });

  describe("github_installations", () => {
    const now = Date.now();

    it("round-trips an insert/select and enforces the (org_id, installation_id) unique index", async () => {
      await drizzleDb.insert(orgs).values({ id: "org-ghi-1", name: "Org GHI", createdAt: now });
      await drizzleDb.insert(githubInstallations).values({
        id: "ghi_1",
        orgId: "org-ghi-1",
        installationId: 12345,
        accountLogin: "acme",
        accountType: "Organization",
        repositorySelection: "selected",
        suspended: false,
        cachedToken: "enc:abc",
        cachedTokenExpiresAt: now + 3600_000,
        createdAt: now,
        updatedAt: now,
      });

      const rows = await drizzleDb
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.id, "ghi_1"));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        id: "ghi_1",
        orgId: "org-ghi-1",
        installationId: 12345,
        accountLogin: "acme",
        accountType: "Organization",
        repositorySelection: "selected",
        suspended: false,
        linkedUserId: null,
        cachedToken: "enc:abc",
        cachedTokenExpiresAt: now + 3600_000,
        createdAt: now,
        updatedAt: now,
      });

      await expect(
        drizzleDb.insert(githubInstallations).values({
          id: "ghi_2",
          orgId: "org-ghi-1",
          installationId: 12345,
          accountLogin: "acme-dupe",
          accountType: "Organization",
          suspended: false,
          createdAt: now,
          updatedAt: now,
        }),
      ).rejects.toThrow();
    });
  });

  describe("linear_installations", () => {
    const now = Date.now();

    it("round-trips an insert/select and enforces the (org_id, workspace_id) unique index", async () => {
      await drizzleDb.insert(orgs).values({ id: "org-li-1", name: "Org LI", createdAt: now });
      await drizzleDb.insert(linearInstallations).values({
        id: "li_1",
        orgId: "org-li-1",
        workspaceId: "ws-abc",
        workspaceName: "Acme Workspace",
        connectedBy: "user-1",
        createdAt: now,
        updatedAt: now,
      });

      const rows = await drizzleDb
        .select()
        .from(linearInstallations)
        .where(eq(linearInstallations.id, "li_1"));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        id: "li_1",
        orgId: "org-li-1",
        workspaceId: "ws-abc",
        workspaceName: "Acme Workspace",
        webhookId: null,
        connectedBy: "user-1",
        createdAt: now,
        updatedAt: now,
      });

      await expect(
        drizzleDb.insert(linearInstallations).values({
          id: "li_2",
          orgId: "org-li-1",
          workspaceId: "ws-abc",
          workspaceName: "Acme Workspace Dupe",
          connectedBy: "user-2",
          createdAt: now,
          updatedAt: now,
        }),
      ).rejects.toThrow();
    });
  });

  describe("events", () => {
    const now = Date.now();

    it("round-trips an insert/select, enforces the (service, dedupe_key) unique index, and onConflictDoNothing no-ops", async () => {
      await drizzleDb.insert(orgs).values({ id: "org-ev-1", name: "Org EV", createdAt: now });
      await drizzleDb.insert(events).values({
        id: "ev_1",
        orgId: "org-ev-1",
        service: "github",
        eventKey: "github.pull_request.opened",
        dedupeKey: "github:pr:42:opened",
        summary: "PR #42 opened",
        payload: {},
        occurredAt: now,
        receivedAt: now,
      });

      const rows = await drizzleDb
        .select()
        .from(events)
        .where(eq(events.id, "ev_1"));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.service).toBe("github");
      expect(rows[0]?.dedupeKey).toBe("github:pr:42:opened");

      // A hard insert with the same (service, dedupe_key) must violate the unique index.
      await expect(
        drizzleDb.insert(events).values({
          id: "ev_2",
          orgId: "org-ev-1",
          service: "github",
          eventKey: "github.pull_request.opened",
          dedupeKey: "github:pr:42:opened",
          summary: "PR #42 opened (dupe)",
          payload: {},
          occurredAt: now,
          receivedAt: now,
        }),
      ).rejects.toThrow();

      // onConflictDoNothing on the same target must silently no-op (load-bearing for ingest).
      await drizzleDb
        .insert(events)
        .values({
          id: "ev_3",
          orgId: "org-ev-1",
          service: "github",
          eventKey: "github.pull_request.opened",
          dedupeKey: "github:pr:42:opened",
          summary: "PR #42 opened (idempotent)",
          payload: {},
          occurredAt: now,
          receivedAt: now,
        })
        .onConflictDoNothing({ target: [events.service, events.dedupeKey] });

      // Only the original row should exist.
      const after = await drizzleDb.select().from(events).where(eq(events.orgId, "org-ev-1"));
      expect(after).toHaveLength(1);
      expect(after[0]?.id).toBe("ev_1");
    });
  });

  // The dev/prod failure mode for the pre-1.0 in-place-edit rule: the
  // database applied `0000_app.sql` before an edit added a column, the
  // tracker skips the file forever after, and only
  // `addColumnsMissingFromAppliedMigrations` can repair the gap. Simulate
  // that database by dropping the columns, then re-run the migrations.
  describe("column repair for in-place 0000 edits", () => {
    const REPAIRED_COLUMNS: Array<{ table: string; column: string }> = [
      { table: "skill_sources", column: "created_by" },
      { table: "orgs", column: "sso_team_groups" },
      { table: "user", column: "model_preferences" },
      { table: "agent_sessions", column: "hibernated_sandbox_id" },
      { table: "agent_sessions", column: "sandbox_reclaimed_at" },
    ];

    async function columnExists(table: string, column: string): Promise<boolean> {
      const result = await db.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2",
        [table, column],
      );
      return result.rows.length > 0;
    }

    it("re-adds columns that predate an already-applied 0000_app.sql", async () => {
      for (const { table, column } of REPAIRED_COLUMNS) {
        await db.query(`ALTER TABLE "${table}" DROP COLUMN "${column}"`);
        expect(await columnExists(table, column), `${table}.${column} dropped`).toBe(false);
      }

      await applyAppMigrations(db);

      for (const { table, column } of REPAIRED_COLUMNS) {
        expect(await columnExists(table, column), `${table}.${column} repaired`).toBe(true);
      }
    });
  });

  describe("better-auth instance over the regenerated pg block", () => {
    it("a real sign-up creates a user row with a role", async () => {
      const auth = betterAuth({
        secret: "test-secret-at-least-32-characters-long",
        baseURL: "http://localhost:8788",
        basePath: "/api/auth",
        database: drizzleAdapter(drizzleDb, {
          provider: "pg",
          schema: {
            user: users,
            session,
            account,
            verification,
            ssoProvider,
            apikey,
            oauthApplication,
            oauthAccessToken,
            oauthConsent,
          },
        }),
        emailAndPassword: { enabled: true },
        user: {
          additionalFields: {
            role: { type: "string", required: true, input: false, defaultValue: "member" },
            defaultModel: { type: "string", required: false },
          },
        },
      });

      const res = await auth.handler(
        new Request("http://localhost:8788/api/auth/sign-up/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Pg Test User", email: "pg-schema-test@nowhere.test", password: "correct-horse-battery" }),
        }),
      );
      expect(res.status).toBe(200);

      const row = await drizzleDb.select().from(users).where(eq(users.email, "pg-schema-test@nowhere.test")).limit(1);
      expect(row).toHaveLength(1);
      expect(row[0]?.role).toBe("member");
      expect(row[0]?.name).toBe("Pg Test User");
    });
  });
});
