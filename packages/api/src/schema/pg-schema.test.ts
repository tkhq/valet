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
import { applyAppMigrations, buildAppDb as buildAppPgDb, missingSchemaRepairs } from "../lib/drizzle.js";
import { isPgLockTimeout } from "@valet/store-postgres";
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
  "security_engagements",
  "security_cells",
  "security_files",
  "security_findings",
  "security_finding_links",
  "security_handoffs",
  "security_finding_comments",
  "security_coverage",
  "security_needs",
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

  it("defaults agent_sessions.kind to 'code'", async () => {
    const result = await db.query(
      "SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = 'agent_sessions' AND column_name = 'kind'",
    );
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0] as { column_default: string; is_nullable: string };
    expect(row.column_default).toContain("'code'");
    expect(row.is_nullable).toBe("NO");
  });

  it("enforces append-only revisions on security_files (engagement, path, revision) unique", async () => {
    const now = Date.now();
    await db.query(
      "INSERT INTO security_files (id, engagement_id, cell_id, path, revision, content, created_at) VALUES ('sf1', 'eng1', 'cell1', '/cells/01-recon/state.yml', 1, 'a', $1)",
      [now],
    );
    await expect(
      db.query(
        "INSERT INTO security_files (id, engagement_id, cell_id, path, revision, content, created_at) VALUES ('sf2', 'eng1', 'cell1', '/cells/01-recon/state.yml', 1, 'b', $1)",
        [now],
      ),
    ).rejects.toThrow(/security_files_path_revision_unique|duplicate key/);
    // Same path, next revision: allowed — that is the append.
    await db.query(
      "INSERT INTO security_files (id, engagement_id, cell_id, path, revision, content, created_at) VALUES ('sf3', 'eng1', 'cell1', '/cells/01-recon/state.yml', 2, 'b', $1)",
      [now],
    );
    await db.query("DELETE FROM security_files WHERE engagement_id = 'eng1'");
  });

  it("links a re-scan engagement to its parent via parent_engagement_id", async () => {
    const now = Date.now();
    // A first review: parent_engagement_id null.
    await db.query(
      "INSERT INTO security_engagements (id, session_id, status, repo_full_name, plan, created_at, updated_at) VALUES ('eng_parent', 's_parent', 'completed', 'acme/api', '', $1, $1)",
      [now],
    );
    // A re-scan: parent_engagement_id names the first review.
    await db.query(
      "INSERT INTO security_engagements (id, session_id, status, repo_full_name, plan, parent_engagement_id, created_at, updated_at) VALUES ('eng_child', 's_child', 'planning', 'acme/api', '', 'eng_parent', $1, $1)",
      [now],
    );
    const rows = await db.query(
      "SELECT id, parent_engagement_id FROM security_engagements WHERE id IN ('eng_parent', 'eng_child') ORDER BY id",
    );
    expect(rows.rows).toEqual([
      { id: "eng_child", parent_engagement_id: "eng_parent" },
      { id: "eng_parent", parent_engagement_id: null },
    ]);
    // No unique constraint on the parent: a second re-scan of the same parent
    // is allowed.
    await db.query(
      "INSERT INTO security_engagements (id, session_id, status, repo_full_name, plan, parent_engagement_id, created_at, updated_at) VALUES ('eng_child2', 's_child2', 'planning', 'acme/api', '', 'eng_parent', $1, $1)",
      [now],
    );
    await db.query("DELETE FROM security_engagements WHERE id IN ('eng_parent', 'eng_child', 'eng_child2')");
  });

  it("stores the diff-scoped re-scan base_ref and changed_paths, defaulting null", async () => {
    const now = Date.now();
    // A full-scan engagement: both diff columns null.
    await db.query(
      "INSERT INTO security_engagements (id, session_id, status, repo_full_name, plan, created_at, updated_at) VALUES ('eng_full', 's_full', 'running', 'acme/api', '', $1, $1)",
      [now],
    );
    // A diff-scoped re-scan: base_ref + a JSON changed-path array.
    await db.query(
      "INSERT INTO security_engagements (id, session_id, status, repo_full_name, plan, base_ref, changed_paths, created_at, updated_at) VALUES ('eng_diff', 's_diff', 'running', 'acme/api', '', 'abc123', $2, $1, $1)",
      [now, JSON.stringify(["src/a.ts", "src/b.ts"])],
    );
    const rows = await db.query(
      "SELECT id, base_ref, changed_paths FROM security_engagements WHERE id IN ('eng_full', 'eng_diff') ORDER BY id",
    );
    expect(rows.rows).toEqual([
      { id: "eng_diff", base_ref: "abc123", changed_paths: JSON.stringify(["src/a.ts", "src/b.ts"]) },
      { id: "eng_full", base_ref: null, changed_paths: null },
    ]);
    await db.query("DELETE FROM security_engagements WHERE id IN ('eng_full', 'eng_diff')");
  });

  it("stores the repo-config context columns, defaulting null / has_repo_config false", async () => {
    const now = Date.now();
    // A preset-seeded engagement: config columns null, has_repo_config false.
    await db.query(
      "INSERT INTO security_engagements (id, session_id, status, repo_full_name, plan, created_at, updated_at) VALUES ('eng_preset', 's_preset', 'planning', 'acme/api', '', $1, $1)",
      [now],
    );
    // A config-seeded engagement: focus text + JSON invariants/categories/
    // personas/tools + has_repo_config true.
    const invariants = JSON.stringify(["tenant id is always checked"]);
    const categories = JSON.stringify(["authz", "multi-tenancy"]);
    const personas = JSON.stringify({ "threat-model": ".claude/agents/threat-model.md" });
    const tools = JSON.stringify(["gitleaks"]);
    await db.query(
      "INSERT INTO security_engagements (id, session_id, status, repo_full_name, plan, focus, invariants, categories, config_personas, config_tools, has_repo_config, created_at, updated_at) VALUES ('eng_cfg', 's_cfg', 'planning', 'acme/api', '', $2, $3, $4, $5, $6, true, $1, $1)",
      [now, "Check the auth boundary", invariants, categories, personas, tools],
    );
    const rows = await db.query(
      "SELECT id, focus, invariants, categories, config_personas, config_tools, has_repo_config FROM security_engagements WHERE id IN ('eng_preset', 'eng_cfg') ORDER BY id",
    );
    expect(rows.rows).toEqual([
      {
        id: "eng_cfg",
        focus: "Check the auth boundary",
        invariants,
        categories,
        config_personas: personas,
        config_tools: tools,
        has_repo_config: true,
      },
      {
        id: "eng_preset",
        focus: null,
        invariants: null,
        categories: null,
        config_personas: null,
        config_tools: null,
        has_repo_config: false,
      },
    ]);
    await db.query("DELETE FROM security_engagements WHERE id IN ('eng_preset', 'eng_cfg')");
  });

  it("stores the report artifact columns, defaulting null (M-P3)", async () => {
    const now = Date.now();
    // A fresh engagement: the report columns are null until the report cell runs.
    await db.query(
      "INSERT INTO security_engagements (id, session_id, status, repo_full_name, plan, created_at, updated_at) VALUES ('eng_norep', 's_norep', 'running', 'acme/api', '', $1, $1)",
      [now],
    );
    // An engagement whose report cell ran: markdown + JSON snapshot + generated time.
    const reportJson = JSON.stringify({ executiveSummary: "one high finding", findings: [] });
    await db.query(
      "INSERT INTO security_engagements (id, session_id, status, repo_full_name, plan, report_markdown, report_json, report_generated_at, created_at, updated_at) VALUES ('eng_rep', 's_rep', 'completed', 'acme/api', '', $2, $3, $4, $1, $1)",
      [now, "# Report\n\nExec summary.", reportJson, now + 5],
    );
    // Cast the bigint to text so the assertion does not depend on the driver's
    // bigint representation (string vs number) — the same reason the other
    // security_engagements schema tests SELECT only text columns.
    const rows = await db.query(
      "SELECT id, report_markdown, report_json, report_generated_at::text AS report_generated_at FROM security_engagements WHERE id IN ('eng_norep', 'eng_rep') ORDER BY id",
    );
    expect(rows.rows).toEqual([
      {
        id: "eng_norep",
        report_markdown: null,
        report_json: null,
        report_generated_at: null,
      },
      {
        id: "eng_rep",
        report_markdown: "# Report\n\nExec summary.",
        report_json: reportJson,
        report_generated_at: String(now + 5),
      },
    ]);
    await db.query("DELETE FROM security_engagements WHERE id IN ('eng_norep', 'eng_rep')");
  });

  it("stores declared tools + authorized_scope, defaulting null (M-P4a/M-P4b)", async () => {
    const now = Date.now();
    // Structured tool decls (M-P4a) + an authorized scope (M-P4b).
    const tools = JSON.stringify([
      { id: "nuclei", install: "apt-get install -y nuclei", egress: ["staging.example.com"] },
      { id: "zap", mcp: { url: "http://127.0.0.1:8090", prefix: "mcp__zap__" } },
    ]);
    const scope = JSON.stringify({ hosts: ["staging.example.com"] });
    await db.query(
      "INSERT INTO security_engagements (id, session_id, status, repo_full_name, plan, config_tools, authorized_scope, has_repo_config, created_at, updated_at) VALUES ('eng_live', 's_live', 'planning', 'acme/api', '', $2, $3, true, $1, $1)",
      [now, tools, scope],
    );
    // A non-live engagement: authorized_scope null.
    await db.query(
      "INSERT INTO security_engagements (id, session_id, status, repo_full_name, plan, created_at, updated_at) VALUES ('eng_nolive', 's_nolive', 'planning', 'acme/api', '', $1, $1)",
      [now],
    );
    const rows = await db.query(
      "SELECT id, config_tools, authorized_scope FROM security_engagements WHERE id IN ('eng_live', 'eng_nolive') ORDER BY id",
    );
    expect(rows.rows).toEqual([
      { id: "eng_live", config_tools: tools, authorized_scope: scope },
      { id: "eng_nolive", config_tools: null, authorized_scope: null },
    ]);
    await db.query("DELETE FROM security_engagements WHERE id IN ('eng_live', 'eng_nolive')");
  });

  it("enforces one issue link per finding per provider", async () => {
    const now = Date.now();
    await db.query(
      "INSERT INTO security_finding_links (id, finding_id, engagement_id, provider, external_id, url, created_by, created_at) VALUES ('sl1', 'fnd1', 'eng1', 'github', '7', 'https://github.com/o/r/issues/7', 'user1', $1)",
      [now],
    );
    await expect(
      db.query(
        "INSERT INTO security_finding_links (id, finding_id, engagement_id, provider, external_id, url, created_by, created_at) VALUES ('sl2', 'fnd1', 'eng1', 'github', '8', 'https://github.com/o/r/issues/8', 'user1', $1)",
        [now],
      ),
    ).rejects.toThrow(/security_finding_links_provider_unique|duplicate key/);
    await db.query("DELETE FROM security_finding_links WHERE engagement_id = 'eng1'");
  });

  it("records fix-session handoffs with no unique constraint per finding", async () => {
    const now = Date.now();
    // Two fix sessions for the same finding — both must persist.
    await db.query(
      "INSERT INTO security_handoffs (id, engagement_id, finding_id, child_session_id, title, task, created_by, created_at) VALUES ('hnd1', 'eng1', 'fnd1', 'child1', 'Fix: A', 'do it', 'user1', $1)",
      [now],
    );
    await db.query(
      "INSERT INTO security_handoffs (id, engagement_id, finding_id, child_session_id, title, task, created_by, created_at) VALUES ('hnd2', 'eng1', 'fnd1', 'child2', 'Fix: A again', NULL, 'user1', $1)",
      [now + 1],
    );
    const rows = await db.query(
      "SELECT id, child_session_id, task FROM security_handoffs WHERE finding_id = 'fnd1' ORDER BY created_at",
    );
    expect(rows.rows).toHaveLength(2);
    // Nullable task round-trips as null.
    expect((rows.rows[1] as { task: string | null }).task).toBeNull();
    await db.query("DELETE FROM security_handoffs WHERE engagement_id = 'eng1'");
  });

  it("records finding comments with no unique constraint per finding", async () => {
    const now = Date.now();
    // Two comments on one finding — a thread; both must persist, oldest first.
    await db.query(
      "INSERT INTO security_finding_comments (id, finding_id, engagement_id, body, author_user_id, created_at) VALUES ('cmt1', 'fnd1', 'eng1', 'Intended: the check is in middleware X.', 'user1', $1)",
      [now],
    );
    await db.query(
      "INSERT INTO security_finding_comments (id, finding_id, engagement_id, body, author_user_id, created_at) VALUES ('cmt2', 'fnd1', 'eng1', 'Confirm this is fixed next scan.', 'user2', $1)",
      [now + 1],
    );
    const rows = await db.query(
      "SELECT id, body, author_user_id FROM security_finding_comments WHERE finding_id = 'fnd1' ORDER BY created_at",
    );
    expect(rows.rows).toHaveLength(2);
    expect((rows.rows[0] as { id: string }).id).toBe("cmt1");
    expect((rows.rows[1] as { author_user_id: string }).author_user_id).toBe("user2");
    await db.query("DELETE FROM security_finding_comments WHERE engagement_id = 'eng1'");
  });

  it("round-trips coverage rows with no unique constraint per cell", async () => {
    const now = Date.now();
    // An assessed row (a check ran) and a not_assessed row (a tool absent) —
    // both persist; the not_assessed carries a consequence reason.
    await db.query(
      "INSERT INTO security_coverage (id, engagement_id, cell_id, area, status, tool, reason, created_at) VALUES ('cov1', 'eng1', 'cell1', 'secrets scan', 'assessed', 'gitleaks', NULL, $1)",
      [now],
    );
    await db.query(
      "INSERT INTO security_coverage (id, engagement_id, cell_id, area, status, tool, reason, created_at) VALUES ('cov2', 'eng1', 'cell1', 'semgrep owasp', 'not_assessed', 'semgrep', 'OWASP sink rules not scanned because semgrep is missing.', $1)",
      [now + 1],
    );
    const rows = await db.query(
      "SELECT id, area, status, tool, reason FROM security_coverage WHERE engagement_id = 'eng1' ORDER BY created_at",
    );
    expect(rows.rows).toHaveLength(2);
    expect((rows.rows[0] as { status: string }).status).toBe("assessed");
    expect((rows.rows[1] as { reason: string }).reason).toContain("semgrep is missing");
    await db.query("DELETE FROM security_coverage WHERE engagement_id = 'eng1'");
  });

  it("round-trips needs rows with no unique constraint per cell", async () => {
    const now = Date.now();
    // An open credential need (needs a human) and an auto_resolved scope need
    // (the coordinator ruled it already-authorized, with a resolution note).
    await db.query(
      "INSERT INTO security_needs (id, engagement_id, cell_id, kind, description, status, resolution, created_at, resolved_at) VALUES ('need1', 'eng1', 'cell1', 'credential', 'A staging API token to reach the admin route.', 'needs_human', NULL, $1, NULL)",
      [now],
    );
    await db.query(
      "INSERT INTO security_needs (id, engagement_id, cell_id, kind, description, status, resolution, created_at, resolved_at) VALUES ('need2', 'eng1', 'cell1', 'scope', 'Sweep the payments dir already in scope.', 'auto_resolved', 'Already inside the authorized scope.', $1, $2)",
      [now + 1, now + 2],
    );
    const rows = await db.query(
      "SELECT id, kind, status, resolution FROM security_needs WHERE engagement_id = 'eng1' ORDER BY created_at",
    );
    expect(rows.rows).toHaveLength(2);
    expect((rows.rows[0] as { status: string }).status).toBe("needs_human");
    expect((rows.rows[1] as { resolution: string }).resolution).toContain("authorized scope");
    await db.query("DELETE FROM security_needs WHERE engagement_id = 'eng1'");
  });

  it("defaults security_needs.status to 'open'", async () => {
    const now = Date.now();
    await db.query(
      "INSERT INTO security_needs (id, engagement_id, cell_id, kind, description, created_at) VALUES ('need3', 'eng1', 'cell1', 'decision', 'Approve a destructive test against staging?', $1)",
      [now],
    );
    const rows = await db.query("SELECT status FROM security_needs WHERE id = 'need3'");
    expect((rows.rows[0] as { status: string }).status).toBe("open");
    await db.query("DELETE FROM security_needs WHERE id = 'need3'");
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
      { table: "agent_sessions", column: "hibernated_sandbox_id" },
      { table: "agent_sessions", column: "sandbox_reclaimed_at" },
      { table: "mcp_oauth_clients", column: "registered_scopes" },
      { table: "mcp_oauth_clients", column: "scopes_supported" },
      { table: "security_engagements", column: "base_ref" },
      { table: "security_engagements", column: "changed_paths" },
      { table: "security_engagements", column: "focus" },
      { table: "security_engagements", column: "invariants" },
      { table: "security_engagements", column: "categories" },
      { table: "security_engagements", column: "config_personas" },
      { table: "security_engagements", column: "config_tools" },
      { table: "security_engagements", column: "authorized_scope" },
      { table: "security_engagements", column: "has_repo_config" },
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

    // TKAI-244: a no-op ALTER TABLE still takes an ACCESS EXCLUSIVE lock, and
    // during a rolling update that lock queues behind the old pod's open
    // transactions — deadlocking the deploy. The steady-state contract is
    // therefore: when nothing is missing, the repair pass issues NO DDL at
    // all, only catalog probes.
    it("reports no missing repairs on an up-to-date schema (steady state takes no locks)", async () => {
      const missing = await missingSchemaRepairs(db);
      expect(missing.map((r) => r.describe)).toEqual([]);
    });

    it("names exactly the dropped column as missing, and repairs restore steady state", async () => {
      await db.query('ALTER TABLE "orgs" DROP COLUMN "sso_team_groups"');
      const missing = await missingSchemaRepairs(db);
      expect(missing.map((r) => r.describe)).toEqual(["orgs.sso_team_groups column"]);

      await applyAppMigrations(db);
      expect(await missingSchemaRepairs(db)).toEqual([]);
      expect(await columnExists("orgs", "sso_team_groups")).toBe(true);
    });

    it("detects a missing table and index independently", async () => {
      await db.query('DROP TABLE "artifacts"'); // drops its indexes too
      const missing = (await missingSchemaRepairs(db)).map((r) => r.describe);
      expect(missing).toContain("artifacts table");
      expect(missing).toContain("artifacts_token_unique index");
      expect(missing).toContain("artifacts_owner_path_unique index");

      await applyAppMigrations(db);
      expect(await missingSchemaRepairs(db)).toEqual([]);
    });

    // #432 added llm_proxy_requests (+ 2 indexes) and rewrote the cost_entries
    // view (a use_case column + a proxy UNION leg). A database migrated before
    // #432 has none of these, and the edited 0000_app.sql never re-runs, so the
    // repair list is the only catch-up path.
    // The pre-#432 cost_entries view, verbatim from before the rewrite: the
    // 17-column engine leg, no use_case, no proxy UNION. Seeding it lets the
    // test drive the real production path (CREATE OR REPLACE over an existing
    // old view), not just CREATE from nothing.
    const PRE_432_COST_ENTRIES = `CREATE VIEW "cost_entries" AS
      SELECT
        e."id"                                                     AS "entry_id",
        e."session_id"                                             AS "session_id",
        e."created_at"                                             AS "created_at",
        e."model"                                                  AS "model",
        COALESCE(s."org_id", d."org_id")                           AS "org_id",
        CASE
          WHEN s."id" IS NOT NULL THEN s."user_id"
          WHEN r."owner_type" = 'user' THEN NULLIF(r."owner_id", '')
        END                                                        AS "user_id",
        COALESCE(s."owner_type", r."owner_type")                   AS "owner_type",
        NULLIF(COALESCE(s."owner_id", r."owner_id"), '')           AS "owner_id",
        r."workflow_id"                                            AS "workflow_id",
        r."id"                                                     AS "workflow_run_id",
        COALESCE((e."usage"::jsonb->>'input')::bigint, 0)          AS "input_tokens",
        COALESCE((e."usage"::jsonb->>'output')::bigint, 0)         AS "output_tokens",
        COALESCE((e."usage"::jsonb->>'cacheRead')::bigint, 0)      AS "cache_read_tokens",
        COALESCE((e."usage"::jsonb->>'cacheWrite')::bigint, 0)     AS "cache_write_tokens",
        COALESCE((e."usage"::jsonb->>'total')::bigint, 0)          AS "total_tokens",
        (e."cost"::jsonb->>'total')::float8                        AS "cost_total",
        ((e."cost"::jsonb->>'total') IS NOT NULL)                  AS "priced"
      FROM "engine_entries" e
      LEFT JOIN "agent_sessions" s ON s."id" = e."session_id"
      LEFT JOIN "workflow_runs" r ON e."session_id" LIKE 'wf:%' AND r."id" = split_part(e."session_id", ':', 2)
      LEFT JOIN "workflow_definitions" d ON d."id" = r."workflow_id"
      WHERE e."usage" IS NOT NULL AND COALESCE(s."org_id", d."org_id") IS NOT NULL`;

    it("repairs the #432 proxy log table, its indexes, and the cost_entries view", async () => {
      // Capture the migration-built view's FULL definition (columns, every
      // expression, and both WHERE clauses) so the repair-built view can be
      // compared against it. pg_get_viewdef normalizes the definition, so two
      // semantically identical views produce identical text regardless of
      // source whitespace — a lockstep check that catches an expression or
      // WHERE-clause slip in the repair's copied SELECT, not just column drift.
      const viewDef = async (): Promise<string> => {
        const r = await db.query("SELECT pg_get_viewdef('cost_entries'::regclass, true) AS def");
        return r.rows[0].def as string;
      };
      const migrationDef = await viewDef();
      expect(migrationDef).toContain("use_case"); // the #432 rewrite is present pre-drop

      // Simulate a real pre-#432 database: the OLD 17-column view is PRESENT
      // and llm_proxy_requests is ABSENT. The old view does not reference the
      // table, so drop the new view, drop the table, then seed the old view.
      await db.query('DROP VIEW "cost_entries"'); // the new view references the table
      await db.query('DROP TABLE "llm_proxy_requests"'); // drops its indexes too
      await db.query(PRE_432_COST_ENTRIES);
      expect(await columnExists("cost_entries", "use_case")).toBe(false); // old shape

      const missing = (await missingSchemaRepairs(db)).map((r) => r.describe);
      expect(missing).toContain("llm_proxy_requests table");
      expect(missing).toContain("llm_proxy_requests_org_created index");
      expect(missing).toContain("llm_proxy_requests_user_created index");
      expect(missing).toContain("cost_entries.use_case (view rewrite)");

      // The table repair MUST run before the view repair (the view references
      // the table). applyAppMigrations completing without error proves the
      // order: a view-first order would fail on the missing table. This also
      // exercises CREATE OR REPLACE over the seeded old view, the deploy path.
      await applyAppMigrations(db);

      expect(await missingSchemaRepairs(db)).toEqual([]);
      expect(await columnExists("llm_proxy_requests", "endpoint")).toBe(true);
      // Full lockstep: the repair-built view is byte-identical to the
      // migration-built view (definition, not just columns).
      expect(await viewDef()).toEqual(migrationDef);
      // The proxy UNION leg resolves against the repaired table (view queryable).
      await db.query("SELECT DISTINCT use_case FROM cost_entries");
    });

    // The repair path's lock_timeout handling rides this store-postgres
    // helper — pin the contract where the dependency lives.
    it("isPgLockTimeout matches pg 55P03 directly and via cause", () => {
      expect(isPgLockTimeout({ code: "55P03" })).toBe(true);
      expect(isPgLockTimeout(new Error("outer", { cause: { code: "55P03" } }))).toBe(true);
      expect(isPgLockTimeout({ code: "42703" })).toBe(false);
      expect(isPgLockTimeout(new Error("plain"))).toBe(false);
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
