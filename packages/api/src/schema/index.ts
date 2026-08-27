import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  jsonb,
  timestamp,
  index,
  primaryKey,
  uniqueIndex,
  check,
  doublePrecision,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { ParamMatcher } from "../policies/matchers.js";

// Postgres rewrite of `schema/index.ts` (docs/specs/2026-07-15-postgres-backend-design.md,
// decision 7). Timestamps convert SELECTIVELY, not blanket:
//   - Columns services do numeric-ms arithmetic on, or compare against
//     `Date.now()` directly, stay `bigint` (mode: "number", read as a plain
//     number) — this is every Valet-owned table below except `invites` and
//     `sandbox_tokens`.
//   - Columns the sqlite schema already declared `{ mode: "timestamp_ms" }`
//     (i.e. genuinely consumed as JS `Date` objects — traced via
//     `packages/api/src/auth/invites.ts` and `.../sandbox-tokens.ts`, both of
//     which call `.getTime()` / compare against `new Date()`) become
//     `timestamp` here: `orgs`... no, `invites`, `sandbox_tokens`, and the
//     entire better-auth block.
// JSON-as-text becomes `jsonb` only where a reader consumes the column as
// JSON (traced via grep — see the per-column disposition table in the task
// report); everything else (e.g. `memory_files.tags`/`.extras`, which Task 9
// feeds into the tsvector generated column as text) stays `text`. The
// driver returns jsonb already parsed — readers must NOT `JSON.parse` the
// value (see `fromJsonbColumn` in `@valet/store-postgres`).
// Boolean-as-integer (`0`/`1` flags with no arithmetic) becomes `boolean`.
// `AUTOINCREMENT` becomes `generated always as identity`.

// ─── Identity ───────────────────────────────────────────────────────────────

export const orgs = pgTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // JSON object of feature flags, e.g. `{ organizations: boolean }`. Read
  // driver-parsed by `services/org.ts` — jsonb.
  features: jsonb("features").notNull().default({}),
  // Ordered list of namespaced model ids (e.g. `"anthropic/claude-opus-4"`)
  // the org has opted into, most-preferred first. Read/written as JSON
  // (`services/org.ts`'s `getOrgModelPreferences`/`setOrgModelPreferences`)
  // — jsonb, mirroring the `features` column above.
  modelPreferences: jsonb("model_preferences").notNull().default([]),
  // Top-level group paths the login team sync mirrors (e.g. `["/platform"]`),
  // editable from Settings (`services/org.ts`). NULL means "never set",
  // which mirrors nothing — the same fail-closed answer as an empty list.
  // When `valet.yaml` declares `auth.sso.teams.groups`, the boot reconciler
  // writes the file's list over this column, so the file wins at every boot
  // — the same precedence as `features` (`services/config-reconcile.ts`).
  ssoTeamGroups: jsonb("sso_team_groups"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  // Org-level toggle: present skill names as bare slash-commands instead of
  // prefixed `/skill <name>`. Replaces the deleted per-user `users.bareSkillCommands`.
  bareSkillCommands: boolean("bare_skill_commands").notNull().default(false),
  // Org-level opt-in for anonymous artifact links (artifacts design). Off =
  // every artifact link requires a logged-in org member, and the `public`
  // visibility option is not offered. Live-checked on every artifact read,
  // so flipping it off immediately re-gates existing `public` artifacts.
  allowPublicArtifacts: boolean("allow_public_artifacts").notNull().default(false),
});

// better-auth's default model name for the user table is "user" (singular);
// we keep the Drizzle export name `users` so existing call sites still
// compile, but the underlying table is named "user" — do not fight
// better-auth with model remapping (auth-v2 design, Schema).
//
// Regenerated via `npx -y @better-auth/cli generate` against a scratch
// `provider: "pg"` config mirroring `src/auth/index.ts` (same plugins: sso,
// apiKey, mcp; same `user.additionalFields`). The CLI's own pg output uses
// plain `timestamp` (no time zone option exists in better-auth's generator
// for any provider — verified by inspecting the installed 1.6.23 CLI/core
// dist for a `timezone`/`withTimezone` knob; there is none), so
// "timestamp with time zone" in the spec's decision 7 is directional (Date-
// typed vs bigint-ms), not literal — this file transcribes the CLI's actual
// `timestamp` output verbatim. Only the two `additionalFields` columns
// (`role`, `defaultModel`) are hand-adjusted to our conventions (role gets
// the literal union type); every other column, including the `$onUpdate`
// callbacks the CLI emits for this version, is verbatim.
export const users = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
  role: text("role", { enum: ["admin", "member"] }).notNull().default("member"),
  // Nullable user preference feeding `EngineHost`'s model override seam;
  // null falls back to the host default (split-settings design, decision 9).
  defaultModel: text("default_model"),
});

// ─── better-auth core + plugin tables ───────────────────────────────────────
//
// Verbatim transcription of the better-auth CLI-generated pg schema for our
// enabled plugins (core, sso, api-key, oidc-provider) — see auth-v2 design
// §Schema and the file-header note above. Do not hand-tune column shapes
// here; regenerate via `npx -y @better-auth/cli generate` against a
// `provider: "pg"` config and diff instead.

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_userId_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index("account_userId_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

export const ssoProvider = pgTable("sso_provider", {
  id: text("id").primaryKey(),
  issuer: text("issuer").notNull(),
  oidcConfig: text("oidc_config"),
  samlConfig: text("saml_config"),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  providerId: text("provider_id").notNull().unique(),
  organizationId: text("organization_id"),
  domain: text("domain").notNull(),
});

export const apikey = pgTable(
  "apikey",
  {
    id: text("id").primaryKey(),
    configId: text("config_id").default("default").notNull(),
    name: text("name"),
    start: text("start"),
    referenceId: text("reference_id").notNull(),
    prefix: text("prefix"),
    key: text("key").notNull(),
    refillInterval: integer("refill_interval"),
    refillAmount: integer("refill_amount"),
    lastRefillAt: timestamp("last_refill_at"),
    enabled: boolean("enabled").default(true),
    rateLimitEnabled: boolean("rate_limit_enabled").default(true),
    rateLimitTimeWindow: integer("rate_limit_time_window").default(86400000),
    rateLimitMax: integer("rate_limit_max").default(10),
    requestCount: integer("request_count").default(0),
    remaining: integer("remaining"),
    lastRequest: timestamp("last_request"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    permissions: text("permissions"),
    metadata: text("metadata"),
  },
  (t) => [
    index("apikey_configId_idx").on(t.configId),
    index("apikey_referenceId_idx").on(t.referenceId),
    index("apikey_key_idx").on(t.key),
  ],
);

export const oauthApplication = pgTable(
  "oauth_application",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    icon: text("icon"),
    metadata: text("metadata"),
    clientId: text("client_id").unique(),
    clientSecret: text("client_secret"),
    redirectUrls: text("redirect_urls"),
    type: text("type"),
    disabled: boolean("disabled").default(false),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (t) => [index("oauthApplication_userId_idx").on(t.userId)],
);

export const oauthAccessToken = pgTable(
  "oauth_access_token",
  {
    id: text("id").primaryKey(),
    accessToken: text("access_token").unique(),
    refreshToken: text("refresh_token").unique(),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    clientId: text("client_id").references(() => oauthApplication.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    scopes: text("scopes"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (t) => [
    index("oauthAccessToken_clientId_idx").on(t.clientId),
    index("oauthAccessToken_userId_idx").on(t.userId),
  ],
);

export const oauthConsent = pgTable(
  "oauth_consent",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").references(() => oauthApplication.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    scopes: text("scopes"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
    consentGiven: boolean("consent_given"),
  },
  (t) => [
    index("oauthConsent_clientId_idx").on(t.clientId),
    index("oauthConsent_userId_idx").on(t.userId),
  ],
);

// ─── Valet-owned auth adjuncts ──────────────────────────────────────────────
//
// `invites` and `sandbox_tokens` are Valet-owned (not part of the CLI-
// regenerated block above) but were declared `{ mode: "timestamp_ms" }` in
// the sqlite schema, and their readers genuinely consume `Date` objects
// (`packages/api/src/auth/invites.ts`'s `row.expiresAt.getTime()` /
// `row.expiresAt <= now` where `now = new Date()`; `sandbox-tokens.ts`'s
// `new Date(now)` inserts and `row.expiresAt <= now` reads) — decision 7's
// "columns consumed as Date become timestamp" rule applies to these two
// tables even though they're not part of the better-auth block.

export const invites = pgTable("invites", {
  id: text("id").primaryKey(),
  codeHash: text("code_hash").notNull().unique(),
  email: text("email"),
  role: text("role", { enum: ["admin", "member"] }).notNull().default("member"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  acceptedBy: text("accepted_by"),
  acceptedAt: timestamp("accepted_at"),
});

export const sandboxTokens = pgTable("sandbox_tokens", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  sessionId: text("session_id").notNull(),
  userId: text("user_id").notNull(),
  orgId: text("org_id").notNull(),
  createdAt: timestamp("created_at").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
});

export const orgMembers = pgTable(
  "org_members",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role", { enum: ["admin", "member"] }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

// ─── Agent sessions ─────────────────────────────────────────────────────────
//
// One row per session the user creates from the UI. The engine maintains its
// own internal state in `engine_sessions`/`engine_threads`/`engine_entries`
// (managed by @valet/store-postgres). This table holds only what the UI cares
// about: human-visible metadata, workspace path, status.

export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    workspace: text("workspace").notNull(),
    title: text("title"),
    status: text("status", {
      enum: ["active", "hibernated", "archived", "deleted"],
    })
      .notNull()
      .default("active"),
    // Principal ownership (decision 8/20 — engine v2). Default 'user'/''
    // matches pre-owner rows; routes that create sessions should populate
    // both explicitly (owner_id = user_id for today's user-owned sessions).
    ownerType: text("owner_type").notNull().default("user"),
    ownerId: text("owner_id").notNull().default(""),
    // Interactive-service profile (sandbox auth gateway plan, Task 5).
    // "headless" (default) is agent-only; "full" additionally runs
    // ttyd + code-server + the auth gateway inside the sandbox.
    // Web-created interactive sessions may request "full", and so may
    // child sessions via the task tool's profile parameter; orchestrator
    // and workflow sessions always hardcode "headless".
    profile: text("profile", { enum: ["headless", "full"] }).notNull().default("headless"),
    // Request a rootless docker daemon inside this session's sandbox
    // (docker-in-sandbox). See docs/specs/2026-08-15-sandbox-docker-design.md.
    docker: boolean("docker").notNull().default(false),
    // The `bakes.id` this session's sandbox booted from, when session
    // create resolved the primary repo binding to a `pushed` bake image
    // (sandbox images v2 plan, Task 4). Null for cold-start sessions (no
    // matching source/bake, or a `customImage: false` provider). Nullable
    // — the vast majority of sessions never resolve a bake.
    bakeId: text("bake_id"),
    // Sandbox id recorded at hibernate time — the reaper's destroy handle
    // for sessions an api restart evicts from the host cache (same rationale
    // as child_watches.parked_sandbox_id).
    hibernatedSandboxId: text("hibernated_sandbox_id"),
    // Stamped once the reaper has destroyed the hibernated sandbox, so the
    // row stops sweeping. Cleared by the next hibernate write.
    sandboxReclaimedAt: bigint("sandbox_reclaimed_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("agent_sessions_user").on(t.userId),
    index("agent_sessions_status").on(t.status),
  ],
);

// Threads — the UI groups messages by thread. The engine has its own thread
// concept too; here we mirror just the fields the chat list needs.
export const sessionThreads = pgTable(
  "session_threads",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    title: text("title"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    // Display-state only: an archived thread leaves the default sidebar
    // list. The engine thread and its history are untouched.
    archivedAt: bigint("archived_at", { mode: "number" }),
  },
  (t) => [index("session_threads_session").on(t.sessionId)],
);

// Messages — the visible chat log. Each row is a single message the UI
// renders. `parts` is JSON-encoded MessagePart[] (text/tool_use/tool_result)
// — read as JSON (decision 7 names this column explicitly) — jsonb.
// `content` is the flat-string projection for legacy/simple consumers.
export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    threadId: text("thread_id"),
    role: text("role", {
      enum: ["user", "assistant", "system", "tool"],
    }).notNull(),
    content: text("content").notNull(),
    parts: jsonb("parts"),
    authorId: text("author_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("messages_session").on(t.sessionId),
    index("messages_thread").on(t.threadId),
    index("messages_created").on(t.createdAt),
  ],
);

// ─── Teams ──────────────────────────────────────────────────────────────────
//
// Teams are the org's membership structure (orchestrator spec, "Identity").
// Names unique per org; last-admin guards on role change/removal and
// creator-auto-admin live in service code (`services/teams.ts`), inside one
// transaction — not expressible as table constraints.
//
// `origin` records where a row came from, as `skills.origin` does below. It
// names the ONE writer of that row's `team_members`:
//
//   `idp`    mirrors an identity-provider group. The login-time sync
//            (`services/team-sync.ts`) owns its membership, and it removes as
//            well as adds — that is what offboarding means.
//   `config` is declared in `valet.yaml`. The boot reconciler
//            (`services/config-reconcile.ts`) asserts the declared members and
//            never deletes one, so the file cannot take access away.
//   `local`  belongs to the people who made it in Valet. Only the team routes
//            write it.
//
// No row has two writers, so no membership has two opinions and nothing can
// oscillate between boot and login. Every sync write is scoped by
// `origin = 'idp'`; every reconciler write is scoped by `origin = 'config'`.
//
// `external_id` holds the full group path (`/platform`). The path is what the
// token claim carries, it survives a realm re-import, and it stays legible in
// a query result. It is NULL for a `local` team and for a `config` team: the
// file identifies a team by `teams[].name`, which `teams_org_name` already
// keeps unique, so a second column would only duplicate the first. Postgres
// treats NULLs as distinct, so `teams_org_external` constrains the mirrored
// rows only, and unlimited NULL rows coexist in it. `origin` is part of that
// key so `external_id` is a per-origin namespace the day a second origin
// populates it.

export const teams = pgTable(
  "teams",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    /**
     * `local` = created in Valet. `config` = declared in `valet.yaml`.
     * `idp` = mirrored from an identity-provider group.
     */
    origin: text("origin", { enum: ["local", "config", "idp"] })
      .notNull()
      .default("local"),
    /**
     * Full identity-provider group path this team mirrors. Null for a `local`
     * and for a `config` team.
     */
    externalId: text("external_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("teams_org_name").on(t.orgId, t.name),
    uniqueIndex("teams_org_external").on(t.orgId, t.origin, t.externalId),
  ],
);

export const teamMembers = pgTable(
  "team_members",
  {
    teamId: text("team_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role", { enum: ["admin", "member"] }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId] }),
    index("team_members_user").on(t.userId),
  ],
);

// ─── Assistants ─────────────────────────────────────────────────────────────

/**
 * An assistant: a named agent a principal owns, with its own session.
 *
 * Replaces `orchestrator_identities`, whose `UNIQUE (org, owner_type,
 * owner_id)` was the one-assistant-per-principal rule. A principal now owns
 * any number, and is the assistant's OWNER and SCOPE rather than its
 * identity. See `docs/specs/2026-08-13-assistants-design.md`.
 *
 * `sessionId` is `assistant:{id}` for every row, the default included — one
 * address, so no consumer has to branch on which kind of assistant it holds.
 */
export const assistants = pgTable(
  "assistants",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    ownerType: text("owner_type", { enum: ["user", "team", "org"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    /** What the reader calls it. Was `orchestrator_identities.handle`. */
    name: text("name"),
    sessionId: text("session_id").notNull(),
    /**
     * The one a machine picks when nobody chose. Workflow orchestrator
     * nodes, event subscriptions and channel bindings all say "the team's
     * assistant" and have no basis for choosing between several, so they
     * resolve to this. Exactly one per principal, held by a partial unique
     * index — see the migration.
     */
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    /** Null while live. Archiving hides an assistant without destroying the
     * conversation it held; the default cannot be archived while default. */
    archivedAt: bigint("archived_at", { mode: "number" }),
  },
  (t) => [
    uniqueIndex("assistants_session").on(t.sessionId),
    index("assistants_owner").on(t.orgId, t.ownerType, t.ownerId),
  ],
);

// ─── Child watches ───────────────────────────────────────────────────────────
//
// Durable record of a spawned child session's pending settlement (decision
// 11). The ChildWatcher (Task 8) arms `awaitResult` per unsettled row and
// re-arms every unsettled row on boot — this table is the restart-survival
// mechanism for `child.settled` reporting. `settled` is a plain 0/1 flag
// with no arithmetic on it (only `eq(childWatches.settled, 0)` equality
// filters) — boolean per decision 7's "boolean-as-integer" rule. NOTE for
// Task 7 (cutover): every `eq(childWatches.settled, 0)` call site
// (`routes/orchestrator.ts`, `orchestrator/children.ts`) must flip to
// `eq(childWatches.settled, false)`, and `r.settled === 1` (`routes/
// orchestrator.ts`) to `r.settled`.

export const childWatches = pgTable(
  "child_watches",
  {
    childSessionId: text("child_session_id").primaryKey(),
    queueItemId: text("queue_item_id").notNull(),
    parentSessionId: text("parent_session_id").notNull(),
    parentThreadId: text("parent_thread_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    orgId: text("org_id").notNull(),
    settled: boolean("settled").notNull().default(false),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    // Display-state only: a dismissed watch leaves the thread tree. The
    // child session row and its history stay reachable from Sessions.
    dismissedAt: bigint("dismissed_at", { mode: "number" }),
    // Retention clock: stamped by markSettled, re-stamped on every settle.
    // The retention sweep destroys a parked sandbox once this is older
    // than the retention window.
    settledAt: bigint("settled_at", { mode: "number" }),
    // Set once the child's sandbox is actually destroyed (eagerly on a
    // non-hibernating backend, by the retention sweep on a hibernating
    // one). NULL on a settled row means a reclaim is still owed;
    // markSettled clears it so a re-opened child starts a fresh cycle.
    sandboxReclaimedAt: bigint("sandbox_reclaimed_at", { mode: "number" }),
    // Provider sandbox id recorded at park time. The retention sweep needs
    // it for a child evicted from the host cache (an api restart) — the
    // engine session row's sandbox_id is only written at creation, before
    // any sandbox provisions, so it cannot serve as the handle.
    parkedSandboxId: text("parked_sandbox_id"),
  },
  (t) => [
    index("child_watches_parent").on(t.parentSessionId),
    index("child_watches_settled").on(t.settled),
    // Partial index for the retention sweep: rows are never deleted and
    // every historical child ends settled, so the sweep's candidate scan
    // must be bounded by the (small) unreclaimed set, not table history.
    index("child_watches_retention")
      .on(t.settledAt)
      .where(sql`${t.settled} = true AND ${t.sandboxReclaimedAt} IS NULL`),
  ],
);

// ─── Notifications + preferences ────────────────────────────────────────────

export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    urgency: text("urgency").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    href: text("href"),
    sessionId: text("session_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    readAt: bigint("read_at", { mode: "number" }),
  },
  (t) => [index("notifications_user_read").on(t.userId, t.readAt)],
);

// `web` is a plain 0/1 flag (`select({ web: ... })`, read truthily by the
// notification-fanout check) — boolean per decision 7. NOTE for Task 7: the
// insert default flips from `.default(1)` to `.default(true)`, and any
// call site treating the read value as a number (none found by grep at
// task time) must switch to boolean comparison.
export const userNotificationPreferences = pgTable(
  "user_notification_preferences",
  {
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    web: boolean("web").notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind] })],
);

// ─── Event drop log ──────────────────────────────────────────────────────────
//
// Durable record of every event/signal rejected by routing or admission
// policy (orchestrator spec, "Policy drops are never invisible"). Reasons
// this phase (Phase 4): hop_budget | edge_denied | pending_cap | child_cap |
// org_ceiling. Phase 6 adds routing-specific reasons (unlinked bindings,
// non-member senders, unbound conversations, trigger-mode filtering) once
// channel routing lands.

export const eventDropLog = pgTable(
  "event_drop_log",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    reason: text("reason").notNull(),
    conversationKey: text("conversation_key"),
    detail: text("detail").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("event_drop_log_org").on(t.orgId)],
);

// ─── Channel bindings + identity links ──────────────────────────────────────
//
// Shapes only (orchestrator spec, "Channel Bindings and Routing") — no
// routing logic lands this phase (Phase 6). One binding per external
// conversation per org is the hard uniqueness rule.

export const channelBindings = pgTable(
  "channel_bindings",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    channelType: text("channel_type").notNull(),
    conversationKey: text("conversation_key").notNull(),
    ownerType: text("owner_type", { enum: ["user", "team", "org"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    sessionId: text("session_id").notNull(),
    threadKeyTemplate: text("thread_key_template").notNull(),
    queueMode: text("queue_mode").notNull(),
    triggerMode: text("trigger_mode", { enum: ["mention", "all"] }).notNull(),
    createdBy: text("created_by", {
      enum: ["user_link", "admin", "agent_outbound"],
    }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("channel_bindings_conversation").on(t.orgId, t.channelType, t.conversationKey),
  ],
);

export const userIdentityLinks = pgTable(
  "user_identity_links",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    notifyAttention: boolean("notify_attention").notNull().default(true),
  },
  (t) => [uniqueIndex("user_identity_links_provider_external").on(t.provider, t.externalId)],
);

// Single-use, short-lived codes for linking an external chat identity to a
// Valet user (deep-link /start flow). Only the sha256 hash is stored.
export const identityLinkCodes = pgTable(
  "identity_link_codes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("identity_link_codes_provider").on(t.provider, t.codeHash)],
);

// One row per provider stream the api has started and not yet stopped.
//
// The engine publishes `text_delta` through `publishEphemeral` — live-only,
// no offset, no replay. An api that dies mid-stream therefore cannot rebuild
// the text, and the reader keeps a message that shimmers forever because
// Slack documents no timeout for an unclosed stream. This table is the
// durable "a stream is open" fact that lets the next boot close it. The text
// itself is not recoverable here and is not meant to be: the `message_end`
// entry in `engine_entries` is the source of truth, and the web UI shows it.
export const channelActiveStreams = pgTable(
  "channel_active_streams",
  {
    channelType: text("channel_type").notNull(),
    conversationKey: text("conversation_key").notNull(),
    /** Provider handle for the streaming message (Slack: chat.startStream's `ts`). */
    messageId: text("message_id").notNull(),
    threadTs: text("thread_ts").notNull(),
    sessionId: text("session_id").notNull(),
    threadId: text("thread_id").notNull(),
    /** Engine message this stream renders. Null until the first message_start. */
    engineMessageId: text("engine_message_id"),
    orgId: text("org_id").notNull(),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({
      name: "channel_active_streams_pk",
      columns: [t.channelType, t.conversationKey, t.messageId],
    }),
    index("channel_active_streams_started").on(t.startedAt),
  ],
);

// ─── Memory (OKF) ────────────────────────────────────────────────────────────
//
// Owner-tuple scoped memory store (decision 13, exact). `search_vector` is a
// `tsvector` GENERATED ALWAYS column — Drizzle's pg-core can't express
// generated-column expressions with weighted `setweight`/`to_tsvector`
// calls, so it's created via raw SQL in `migrations/pg/0000_app.sql`
// (mirrors the old fts5-virtual-table comment: intentionally no Drizzle
// column definition for it here) plus a GIN index. Weights (spec decision
// 9): A=title, B=description, C=path+tags, D=content — path must NOT
// collapse into the same weight class as content, or a path-term match
// ranks like a body mention. The weight-C expression also runs
// `path || ' ' || tags` through `regexp_replace(..., '[^a-zA-Z0-9]+', ' ',
// 'g')` before `to_tsvector` — verified empirically that Postgres's parser
// otherwise classifies a slash-containing string like
// `instruments/xylophone/setup.md` as a single opaque "file" token instead
// of splitting it into searchable words, so a bare path-term query would
// never match (see the migration's comment for the raw tsvector output that
// caught this).
//
// `tags`/`extras` stay `text` (JSON.stringify'd), NOT jsonb: `tags` feeds
// the weight-C generated-column expression as a plain string
// (`coalesce(path,'') || ' ' || coalesce(tags,'')`) — concatenating a jsonb
// array into a tsvector needs an extra unnest/aggregate step Task 9 (memory
// service port) owns; keeping `tags` as text keeps the generated-column
// expression a straight string concat, matching how `ftsTags()` already
// flattens the JSON array to a space-joined string before feeding fts5
// today. `expires`/`updatedAt`/`createdAt` stay bigint ms — the service's
// `expiresMs`/`updatedAtMs` contract (decision 7, named explicitly) reads
// them as plain numbers, never as `Date`.

export const memoryFiles = pgTable(
  "memory_files",
  {
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    path: text("path").notNull(),
    title: text("title").notNull().default(""),
    content: text("content").notNull(),
    type: text("type").notNull().default(""),
    description: text("description").notNull().default(""),
    tags: text("tags").notNull().default("[]"),
    resource: text("resource").notNull().default(""),
    extras: text("extras").notNull().default("{}"),
    sensitivity: text("sensitivity").notNull().default("private"),
    origin: text("origin").notNull().default(""),
    expires: bigint("expires", { mode: "number" }),
    pinned: boolean("pinned").notNull().default(false),
    actorUserId: text("actor_user_id").notNull().default(""),
    sourceSessionId: text("source_session_id").notNull().default(""),
    orgId: text("org_id").notNull().default(""),
    version: integer("version").notNull().default(1),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.ownerType, t.ownerId, t.path] })],
);

// ─── Artifacts ──────────────────────────────────────────────────────────────
//
// Shared snapshots of memory files (2026-08-22 artifacts design). A row is a
// COPY of one memory file's content at share time, not a live reference —
// later memory edits never publish until an explicit re-share overwrites
// `content`. `token` is the unguessable capability in the share URL
// (`/a/{token}`); `visibility` gates who may open it: `org` (a logged-in
// member of `org_id`) or `public` (anyone, only while
// `orgs.allow_public_artifacts` is on). The tool surface can only create
// `org` rows; widening to `public` is a human UI action recorded in
// `public_by`. Revoke sets `revoked_at` and keeps the row for audit;
// re-share after revoke mints a fresh token (a leaked link stays dead)
// AND resets visibility to `org` — revoke ends the audience decision
// along with the link, so the tool surface can never restore anonymous
// access.
export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull(),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    orgId: text("org_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    sourceSessionId: text("source_session_id").notNull().default(""),
    sourceMemoryPath: text("source_memory_path").notNull(),
    title: text("title").notNull().default(""),
    content: text("content").notNull(),
    visibility: text("visibility", { enum: ["org", "public"] }).notNull().default("org"),
    publicBy: text("public_by"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    revokedAt: bigint("revoked_at", { mode: "number" }),
  },
  (t) => [
    uniqueIndex("artifacts_token_unique").on(t.token),
    // One artifact per shared file: re-share is an update, never a second row.
    uniqueIndex("artifacts_owner_path_unique").on(t.ownerType, t.ownerId, t.sourceMemoryPath),
  ],
);

// ─── Skills ─────────────────────────────────────────────────────────────────
//
// Stored skills — the markdown playbooks a person writes in the product, and
// (later) the ones a repository supplies. Plugin skills are NOT here: they
// ship inside plugin packages and are assembled from the manifest, so the
// two sets meet only at delivery time (`plugins/assemble.ts`).
//
// `content` holds the BODY, with the frontmatter already removed, and
// `frontmatter` holds the parsed frontmatter map. The split is what keeps a
// bad row from breaking a session build: delivery reads `name`,
// `description`, and `content` straight from these columns, so it never
// parses and never throws. Every frontmatter rule is checked once, on write
// (`services/skills.ts`).
//
// `content_sha` is the SHA-256 of `content`. The repo importer will compare
// it to decide whether an upstream body changed.
//
// `source_id` will point at a `skill_sources` row once repository sync
// exists. It carries no foreign key yet, because that table is not built.
//
// Ownership columns and the owner index mirror `workflow_definitions` below,
// because skill access follows the same rule: your own rows plus the rows of
// every team you belong to. The UNIQUE index is the backstop for the one
// collision the delivery seam must never see twice — two stored skills with
// one name inside a single owner scope.
export const skills = pgTable(
  "skills",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    ownerType: text("owner_type", { enum: ["user", "team", "org"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    /** `local` = authored in the product. `repo` = synced from a repository. */
    origin: text("origin", { enum: ["local", "repo"] }).notNull(),
    sourceId: text("source_id"),
    name: text("name").notNull(),
    description: text("description").notNull(),
    content: text("content").notNull(),
    frontmatter: jsonb("frontmatter").notNull().default({}),
    contentSha: text("content_sha").notNull(),
    /** Path of the `SKILL.md` inside its repository. Null for a local skill. */
    upstreamPath: text("upstream_path"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("skills_owner").on(t.orgId, t.ownerType, t.ownerId),
    uniqueIndex("skills_owner_name").on(t.orgId, t.ownerType, t.ownerId, t.name),
  ],
);

// One tracked skill repository. A `repo`-origin row in `skills` above is a
// MIRROR of a `SKILL.md` in one of these repositories, and sync is the only
// thing that writes those rows, so a source and the skills it carries are
// created and destroyed together.
//
// Do not confuse this row with the engine's `SkillSource` type, which is one
// assembled skill on its way into a session. In prose here, "skill source"
// always means the tracked repository.
//
// `ref` empty means the repository's default branch. `subpath` empty means
// the repository root. Both are part of the UNIQUE key, so one repository can
// be tracked twice from two different subdirectories.
//
// The last four sync columns are the whole change-detection state:
// `last_sha` is the commit the last sync read, and `last_manifest_hash` is a
// hash over the skill files that commit held. A poll that finds the same
// commit stops after one API call; a poll that finds a moved commit with the
// same manifest records the commit and writes no skill rows.
//
// `status`/`attempts`/`next_attempt_at`/`last_error` are the sweep's claim
// and retry state, shaped like `event_deliveries` — see
// `services/skill-sync.ts` for the claim statement and the backoff ladder.
// `last_error` carries whatever the last sync needs to tell the reader:
// the failure for `status='error'`, and the per-skill warnings for
// `status='warning'` (a sync that succeeded but skipped a malformed file).
export const skillSources = pgTable(
  "skill_sources",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    ownerType: text("owner_type", { enum: ["user", "team", "org"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    /** The user who added the source. This is the only user identity a team
     * source or an org source carries, and the sweep runs with no request
     * context, so it is what `services/skill-source-credential.ts` reads to
     * pick a team source's GitHub credential. NULL means the row predates
     * this column, and a NULL row syncs with no credential. */
    createdBy: text("created_by"),
    /** `owner/repo`. */
    repoFullName: text("repo_full_name").notNull(),
    /** Branch, tag, or commit. Empty means the default branch. */
    ref: text("ref").notNull().default(""),
    /** Narrows the skill scan to one directory. Empty scans the whole
     * repository, which is the normal case. */
    subpath: text("subpath").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),
    status: text("status", { enum: ["pending", "ok", "warning", "error"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: bigint("next_attempt_at", { mode: "number" }).notNull(),
    lastSha: text("last_sha"),
    lastManifestHash: text("last_manifest_hash"),
    lastSyncedAt: bigint("last_synced_at", { mode: "number" }),
    lastError: text("last_error"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("skill_sources_owner").on(t.orgId, t.ownerType, t.ownerId),
    index("skill_sources_due").on(t.enabled, t.nextAttemptAt),
    uniqueIndex("skill_sources_repo").on(
      t.orgId,
      t.ownerType,
      t.ownerId,
      t.repoFullName,
      t.subpath,
    ),
  ],
);

// ─── Workflows (engine v2 Phase 5) ──────────────────────────────────────────
//
// App-side persistence for the `@valet/workflow` run host (plan decision
// 17). `workflow_runs` is the durable `WorkflowRun` row (park state +
// ownership + immutable-at-start params/definition snapshot);
// `workflow_checkpoints`/`workflow_signals` back the `WorkflowStore` port's
// checkpoint and signal contracts exactly (`packages/api/src/workflows/
// pg-store.ts` implements the port over these three tables plus
// `workflow_definitions`). JSON columns (`definition`, `params`,
// `waiting_on`, `result`, `effects`, `payload`, `consumed_by`) are `jsonb`
// here — decision 7 names "workflow definitions" explicitly, and the same
// read-as-JSON rule extends to every other jsonb column `pg-store.ts`
// touches (written `JSON.stringify`'d, read back already-parsed — see that
// file's doc comment). `error` stays `text` — it's a plain error message
// string, never parsed as JSON.

export const workflowDefinitions = pgTable(
  "workflow_definitions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    ownerType: text("owner_type", { enum: ["user", "team", "org"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    definition: jsonb("definition").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [index("workflow_definitions_owner").on(t.orgId, t.ownerType, t.ownerId)],
);

// Immutable snapshot per save: version 1 on create, +1 on every
// update/patch. Reads join through `workflow_definitions` for ownership,
// so no owner columns here.
export const workflowVersions = pgTable(
  "workflow_versions",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id").notNull(),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    definition: jsonb("definition").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("workflow_versions_wf_version").on(t.workflowId, t.version)],
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id").notNull(),
    definitionVersionId: text("definition_version_id").notNull(),
    definition: jsonb("definition").notNull(),
    params: jsonb("params").notNull(),
    status: text("status", {
      enum: ["pending", "running", "parked", "terminalizing", "settled"],
    })
      .notNull()
      .default("pending"),
    outcome: text("outcome", { enum: ["completed", "failed", "cancelled"] }),
    waitingOn: jsonb("waiting_on").notNull().default([]),
    wakeAt: bigint("wake_at", { mode: "number" }),
    // Plain 0/1 flag (`row.wake_requested !== 0` in sqlite-store.ts) — boolean.
    wakeRequested: boolean("wake_requested").notNull().default(false),
    // Named `lease_owner_id` (not `owner_id`) to avoid clashing with the
    // principal-ownership `owner_type`/`owner_id` columns below (plan
    // decision 17).
    leaseOwnerId: text("lease_owner_id"),
    leaseExpiresAt: bigint("lease_expires_at", { mode: "number" }),
    attempt: integer("attempt").notNull().default(0),
    // Principal ownership, resolved from the parent `workflow_definitions`
    // row by the API layer (Task 10) — the `WorkflowStore` port's
    // `createRun(runId, params, ...)` doesn't carry owner info (`RunParams`
    // has no owner fields), so `createRun` writes these defaults, matching
    // `agent_sessions`' pre-owner-column backfill convention; the route
    // handler that starts a run sets the real values in the same insert
    // path once it resolves the workflow's owner.
    ownerType: text("owner_type").notNull().default("user"),
    ownerId: text("owner_id").notNull().default(""),
    // When the settled-run sandbox reclaim destroyed this run's session
    // sandboxes (workflows/sandbox-reclaim.ts). NULL until the run settles
    // AND every session sandbox is gone — the sweep retries NULL rows.
    sandboxReclaimedAt: bigint("sandbox_reclaimed_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("workflow_runs_status_updated").on(t.status, t.updatedAt),
    index("workflow_runs_workflow").on(t.workflowId),
  ],
);

export const workflowCheckpoints = pgTable(
  "workflow_checkpoints",
  {
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    iteration: integer("iteration").notNull().default(0),
    attempt: integer("attempt").notNull(),
    status: text("status", {
      enum: ["intent", "completed", "failed", "skipped"],
    }).notNull(),
    result: jsonb("result"),
    effects: jsonb("effects"),
    error: text("error"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.nodeId, t.iteration] }),
    index("workflow_checkpoints_run").on(t.runId),
  ],
);

export const workflowSignals = pgTable(
  "workflow_signals",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    runId: text("run_id").notNull(),
    signalId: text("signal_id").notNull(),
    signalType: text("signal_type").notNull(),
    payload: jsonb("payload"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    consumedAt: bigint("consumed_at", { mode: "number" }),
    consumedBy: jsonb("consumed_by"),
  },
  (t) => [
    uniqueIndex("workflow_signals_run_signal").on(t.runId, t.signalId),
    index("workflow_signals_run").on(t.runId),
  ],
);

// ─── Credentials (plugin-system-v2 Task 3) ──────────────────────────────────
//
// Durable, encrypted store backing the engine's `CredentialStore` port
// (`packages/engine/src/types.ts`). Secret columns hold AES-256-GCM
// ciphertext produced by `src/lib/secret-crypto.ts` — plaintext tokens are
// never persisted. `scopes`/`metadata` are jsonb, read driver-parsed by
// `plugins/credential-store.ts` (never re-`JSON.parse`'d).

export const credentials = pgTable(
  "credentials",
  {
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    service: text("service").notNull(),
    type: text("type", {
      enum: ["oauth2", "api_key", "bot_token", "service_account", "app_install"],
    }).notNull(),
    accessTokenEnc: text("access_token_enc"),
    refreshTokenEnc: text("refresh_token_enc"),
    apiKeyEnc: text("api_key_enc"),
    expiresAt: bigint("expires_at", { mode: "number" }),
    scopes: jsonb("scopes"),
    metadata: jsonb("metadata"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.ownerType, t.ownerId, t.service] })],
);

// `mcp_oauth_clients` — one dynamically-registered OAuth client per MCP
// service, shared across all users (integration-OAuth design,
// docs/specs/2026-07-20-integration-oauth-design.md). Never deleted on
// disconnect; if the deployment's public URL changes the registered
// redirect URI goes stale and the recovery is deleting the row.
export const mcpOauthClients = pgTable("mcp_oauth_clients", {
  service: text("service").primaryKey(),
  clientId: text("client_id").notNull(),
  clientSecretEnc: text("client_secret_enc"),
  authorizationEndpoint: text("authorization_endpoint").notNull(),
  tokenEndpoint: text("token_endpoint").notNull(),
  registrationEndpoint: text("registration_endpoint"),
  // The RFC 7591 scope set the client was registered with (sorted). Null on
  // rows registered before scopes support; a declared-scope change
  // re-registers and replaces the row (integration-oauth.ts).
  registeredScopes: jsonb("registered_scopes").$type<string[]>(),
  // What discovery advertised as scopes_supported, captured at registration
  // (or lazily backfilled). Drives the scopeless-entry warning on every
  // connect. [] = the server advertises none; null = not yet captured.
  scopesSupported: jsonb("scopes_supported").$type<string[]>(),
  metadata: jsonb("metadata"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});
// ─── Org action-policy engine (action-policies plan, Task 2) ───────────────
//
// Three tables: `action_policies` (durable org-level rules, `principalType:
// "org"`; `principalType: "user"` rows are reserved for a future admin
// per-user-policy rung — the adjudicated precedence order in
// `policies/resolution.ts` only consults `principalType: "org"` rows today),
// `runtime_grants` (ephemeral "allow for this session/run" quiets, always
// `mode: "allow"`), `action_policy_overrides` (durable per-user overrides).
// All three feed `policies/resolution.ts`'s pure `resolvePolicyDecision` —
// see that module's doc comment for the full precedence order. The
// "exactly one of service/actionId/riskLevel" and "exactly one of
// sessionId/workflowExecutionId" CHECK constraints below are the DB-level
// backstop for `resolution.ts`'s `matchesTarget`/one-of assumptions; a
// service layer (T3-T5) is expected to validate the same shape before
// insert so a bad row never reaches the DB in the first place.

export const actionPolicies = pgTable(
  "action_policies",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    principalType: text("principal_type", { enum: ["org", "user"] }).notNull(),
    principalId: text("principal_id").notNull(),
    service: text("service"),
    actionId: text("action_id"),
    riskLevel: text("risk_level", { enum: ["low", "medium", "high", "critical"] }),
    mode: text("mode", { enum: ["allow", "require_approval", "deny"] }).notNull(),
    paramMatchers: jsonb("param_matchers").notNull().default([]).$type<ParamMatcher[]>(),
    appliesIn: text("applies_in", { enum: ["any", "workflow", "session"] })
      .notNull()
      .default("any"),
    origin: text("origin", {
      enum: ["settings", "approval_prompt", "workflow_editor", "admin"],
    }).notNull(),
    managedBy: text("managed_by"),
    expiresAt: bigint("expires_at", { mode: "number" }),
    revokedAt: bigint("revoked_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("action_policies_org_revoked").on(t.orgId, t.revokedAt),
    check(
      "action_policies_one_of_target",
      sql`((${t.service} is not null)::int + (${t.actionId} is not null)::int + (${t.riskLevel} is not null)::int) = 1`,
    ),
  ],
);

// Ephemeral allow-only grants scoped to a live session or workflow
// execution. Hard-deleted by the owning service on terminal-state
// transition of the parent context (no FK cascade — matches the sibling
// tables' convention of "cascade by code, not by constraint"). `policyKey`
// is the exact `service.actionId` idempotency/match key computed by
// `policies/resolution.ts`'s `grantPolicyKey` — grants quiet ONE exact
// action, not a broader service/risk-level target.
export const runtimeGrants = pgTable(
  "runtime_grants",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    sessionId: text("session_id"),
    workflowExecutionId: text("workflow_execution_id"),
    policyKey: text("policy_key").notNull(),
    mode: text("mode", { enum: ["allow"] }).notNull().default("allow"),
    grantedBy: text("granted_by").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    revokedAt: bigint("revoked_at", { mode: "number" }),
  },
  (t) => [
    check(
      "runtime_grants_one_of_scope",
      sql`((${t.sessionId} is not null)::int + (${t.workflowExecutionId} is not null)::int) = 1`,
    ),
    // Per-scope grant idempotency (mirrors legacy's select-before-insert):
    // partial unique indexes live in migrations/pg/0000_app.sql directly —
    // Drizzle's pg-core `uniqueIndex()` has no portable WHERE clause.
  ],
);

// Durable per-user overrides. Unlike `action_policies` these have no
// `appliesIn`/expiry — a user's override applies everywhere until replaced.
export const actionPolicyOverrides = pgTable(
  "action_policy_overrides",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    service: text("service"),
    actionId: text("action_id"),
    riskLevel: text("risk_level", { enum: ["low", "medium", "high", "critical"] }),
    mode: text("mode", { enum: ["allow", "require_approval", "deny"] }).notNull(),
    paramMatchers: jsonb("param_matchers").notNull().default([]).$type<ParamMatcher[]>(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("action_policy_overrides_org_user").on(t.orgId, t.userId),
    check(
      "action_policy_overrides_one_of_target",
      sql`((${t.service} is not null)::int + (${t.actionId} is not null)::int + (${t.riskLevel} is not null)::int) = 1`,
    ),
  ],
);

// `action_invocations` — durable dedup table for the workflow `tool` node's
// `invokeAction` seam (plugin-system-v2 plan Task 6). `result` is jsonb:
// written by `plugins/action-invoker.ts`, read back driver-parsed.
// A duplicate `invocationId` (crash-and-retry, concurrent
// dispatch) reads back the original row rather than re-invoking the action.
//
// Extended (action-policies plan, Task 2) into a general policy-invocation
// audit log: every column below `createdAt` is new and NULLABLE, so the
// original 3-column workflow-node insert shape (`invocationId`, `result`,
// `createdAt`) keeps working unmodified — see `schema/pg-schema.test.ts`'s
// pinned regression test. `result` itself is relaxed from NOT NULL to
// nullable (an audit row for a denied/rejected invocation has no result
// yet) rather than adding a second column of the same name; existing
// writers always populate it, so this is additive in practice.
// `params`/`result` are capped at 8KB by the writer, with the paired
// `*Truncated` booleans recording when that cap was hit.
export const actionInvocations = pgTable(
  "action_invocations",
  {
    invocationId: text("invocation_id").primaryKey(),
    result: jsonb("result"),
    resultTruncated: boolean("result_truncated"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    service: text("service"),
    actionId: text("action_id"),
    riskLevel: text("risk_level", { enum: ["low", "medium", "high", "critical"] }),
    resolvedMode: text("resolved_mode", { enum: ["allow", "require_approval", "deny"] }),
    baseMode: text("base_mode", { enum: ["allow", "require_approval", "deny"] }),
    matchedPolicyId: text("matched_policy_id"),
    matchedGrantId: text("matched_grant_id"),
    matchedOverrideId: text("matched_override_id"),
    status: text("status", {
      enum: ["pending", "allowed", "denied", "approved", "rejected", "error", "completed", "cancelled", "timeout"],
    }),
    sessionId: text("session_id"),
    workflowExecutionId: text("workflow_execution_id"),
    userId: text("user_id"),
    orgId: text("org_id"),
    params: jsonb("params"),
    paramsTruncated: boolean("params_truncated"),
    durationMs: bigint("duration_ms", { mode: "number" }),
    error: text("error"),
    startedAt: bigint("started_at", { mode: "number" }),
    resolvedBy: text("resolved_by"),
  },
  (t) => [
    index("action_invocations_session").on(t.sessionId),
    index("action_invocations_org_created").on(t.orgId, t.createdAt),
  ],
);

// ─── LLM providers (org BYO keys + custom providers) ────────────────────────
//
// One row per org-configured LLM provider. The known kinds
// (`anthropic`/`openai`/`google`/`openrouter`) are per-org singletons —
// enforced here via a partial unique index (Drizzle's pg-core has no
// portable way to express a `WHERE` clause on a `uniqueIndex()`, so it's
// declared in `migrations/pg/0000_app.sql` directly) AND in
// `services/org.ts` / the Task 3-5 provider service (the service-layer
// check is the one tests pin — see task brief). `openai_compatible` rows
// are custom providers and may have any number per org. `models` is
// populated for `openai_compatible` providers (their full declared list)
// and for `openrouter` rows (the admin's curated selection from pi-ai's
// openrouter registry — seeded with `OPENROUTER_DEFAULT_MODEL_IDS` at
// create); the other known kinds resolve their model list from the
// engine's built-in catalog. Read/written as JSON, jsonb per the
// `features`/`modelPreferences` convention above.

export interface LlmProviderModel {
  id: string;
  name: string;
  contextWindow?: number;
  pricing?: { input: number; output: number };
}

export const llmProviders = pgTable(
  "llm_providers",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    kind: text("kind", {
      enum: ["anthropic", "openai", "google", "openrouter", "openai_compatible"],
    }).notNull(),
    name: text("name").notNull(),
    baseUrl: text("base_url"),
    enabled: boolean("enabled").notNull().default(true),
    models: jsonb("models").notNull().default([]).$type<LlmProviderModel[]>(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("llm_providers_org").on(t.orgId)],
);

export const llmProxyRequests = pgTable(
  "llm_proxy_requests",
  {
    id: text("id").primaryKey(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    apiKeyId: text("api_key_id").notNull(),
    providerKind: text("provider_kind", { enum: ["anthropic", "openai"] }).notNull(),
    model: text("model"),
    harness: text("harness"),
    endpoint: text("endpoint").notNull(),
    providerResponseId: text("provider_response_id"),
    previousResponseId: text("previous_response_id"),
    stream: boolean("stream").notNull(),
    statusCode: integer("status_code").notNull(),
    requestBody: text("request_body").notNull(),
    responseBody: text("response_body"),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).notNull().default(0),
    totalTokens: bigint("total_tokens", { mode: "number" }).notNull().default(0),
    costUsd: doublePrecision("cost_usd"),
    latencyMs: integer("latency_ms"),
    error: text("error"),
    parsed: jsonb("parsed"),
    parseVersion: integer("parse_version"),
    parseError: text("parse_error"),
  },
  (t) => [index("llm_proxy_requests_org_created").on(t.orgId, t.createdAt),
          index("llm_proxy_requests_user_created").on(t.userId, t.createdAt)],
);

export type LlmProxyRequestRow = typeof llmProxyRequests.$inferSelect;

// ─── Session repo bindings (GitHub/repo integration plan, Task 2) ──────────
//
// One row per repo bound to a session (session-create route accepts
// `repo`/`repos` and inserts a row per binding, position = array order).
// No actual FK to `agent_sessions` — matches sibling tables' convention
// (`session_threads`, `messages`) of a plain indexed `session_id` text
// column with cascade-by-code, not by constraint.
export const sessionRepos = pgTable(
  "session_repos",
  {
    sessionId: text("session_id").notNull(),
    host: text("host").notNull().default("github"),
    fullName: text("full_name").notNull(),
    cloneUrl: text("clone_url").notNull(),
    ref: text("ref"),
    auth: text("auth", { enum: ["auto", "app", "user"] })
      .notNull()
      .default("auto"),
    position: integer("position").notNull(),
    // Target directory inside the sandbox workspace for this repo binding.
    // Set ONCE at bind time by the session-create route and never relocated
    // afterward (decision 15 — a binding's target dir is stable for its life).
    // NULL marks a legacy binding created before decision 15 landed.
    targetDir: text("target_dir"),
  },
  (t) => [
    index("session_repos_session").on(t.sessionId),
    uniqueIndex("session_repos_session_position").on(t.sessionId, t.position),
  ],
);

// ─── GitHub App installations (GitHub/repo integration plan, Task 2) ───────
//
// One row per org-linked GitHub App installation. `cachedToken` /
// `cachedTokenExpiresAt` cache the short-lived installation access token
// (encrypted at rest by the writer, like `credentials.*Enc` columns) so
// later tasks (sandbox clone auth) don't mint a new one per request.
export const githubInstallations = pgTable(
  "github_installations",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(),
    repositorySelection: text("repository_selection"),
    suspended: boolean("suspended").notNull().default(false),
    linkedUserId: text("linked_user_id"),
    cachedToken: text("cached_token"),
    cachedTokenExpiresAt: bigint("cached_token_expires_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("github_installations_org_installation").on(t.orgId, t.installationId),
    index("github_installations_org_account").on(t.orgId, t.accountLogin),
  ],
);

// ─── Sandbox image sources + bakes (sandbox-reconciliation plan, Task 13) ──
//
// Two tables replace the old image_catalog/prebuild_configs/prebuilds trio:
//
// `image_sources` — one row per named image source an org has registered.
//   kind='external': a plain external image ref (replaces image_catalog).
//   kind='base': the org's single base image layer (partial unique index).
//   kind='repo': a repo-tied source whose nightly/manual bakes produce the
//     prebuilt sandbox image (replaces prebuild_configs). Partial unique
//     index on (org_id, repo_host, repo_full_name) for kind='repo' only.
//   `parent_id` chains sources (e.g. repo source → base source). Nullable;
//   Task 15 owns real parent-first resolution.
//
// `bakes` — one row per build attempt for a source (replaces prebuilds).
//   `identity_hash` is the recipe-content hash used to detect unnecessary
//   rebuilds; Task 15 populates it with a real hash. This task uses "".
//   `recipe`/`builder_backend` are nullable (unlike old prebuilds) because
//   kind='external'/'base' sources may never bake. `commit_sha` is optional
//   for the same reason.

export const imageSources = pgTable(
  "image_sources",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    kind: text("kind", { enum: ["external", "base", "repo"] }).notNull(),
    parentId: text("parent_id"),
    name: text("name").notNull(),
    // kind='external' fields
    externalRef: text("external_ref"),
    pullSecretName: text("pull_secret_name"),
    // kind='base' fields
    setupCommands: jsonb("setup_commands"),
    // Populated only for kind='base' rows. Identifies which session profile
    // this base image targets. Null for kind='external' and kind='repo'.
    profile: text("profile", { enum: ["headless", "full"] }),
    // kind='repo' fields
    repoHost: text("repo_host"),
    repoFullName: text("repo_full_name"),
    cloneUrl: text("clone_url"),
    // Shared scheduling/state
    schedule: text("schedule", { enum: ["nightly", "off"] })
      .notNull()
      .default("nightly"),
    enabled: boolean("enabled").notNull().default(true),
    lastBoundAt: bigint("last_bound_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  // Partial unique indexes are not expressible via Drizzle's uniqueIndex()
  // with a WHERE clause — declared in migrations/pg/0000_app.sql instead
  // (same pattern as llm_providers_org_kind_singleton).
  () => [],
);

export const bakes = pgTable(
  "bakes",
  {
    id: text("id").primaryKey(),
    // ON DELETE CASCADE: dropping a source purges its build history.
    sourceId: text("source_id").notNull(),
    // Recipe-content hash for redundant-rebuild detection (Task 15 owns real
    // hash; this task seeds "" as a placeholder).
    identityHash: text("identity_hash").notNull(),
    // Nullable: kind='external'/'base' bakes may have no commit.
    commitSha: text("commit_sha"),
    imageRef: text("image_ref").notNull(),
    status: text("status", {
      enum: ["queued", "building", "pushed", "failed"],
    }).notNull(),
    // Nullable to match DDL (base/external sources may omit builder details).
    builderBackend: text("builder_backend"),
    recipe: jsonb("recipe"),
    error: text("error"),
    logTail: text("log_tail"),
    startedAt: bigint("started_at", { mode: "number" }),
    finishedAt: bigint("finished_at", { mode: "number" }),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("bakes_source_status_created").on(t.sourceId, t.status, t.createdAt)],
);

// ─── Event system (event-system plan, Task 3) ───────────────────────────────
//
// Four tables: `events` (the canonical deduped event record), `event_subscriptions`
// (org-owned subscriptions with pattern-matching + filters), `event_deliveries`
// (per-subscription delivery tracking with retry state), `linear_installations`
// (Linear workspace OAuth installs, analogous to `github_installations`).

export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    service: text("service").notNull(),
    eventKey: text("event_key").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    actor: jsonb("actor"),
    refs: jsonb("refs").notNull().default({}),
    summary: text("summary").notNull(),
    payload: jsonb("payload").notNull(),
    occurredAt: bigint("occurred_at", { mode: "number" }).notNull(),
    receivedAt: bigint("received_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("events_service_dedupe").on(t.service, t.dedupeKey),
    index("events_org_received").on(t.orgId, t.receivedAt),
    index("events_org_key").on(t.orgId, t.eventKey),
  ],
);

export const eventSubscriptions = pgTable(
  "event_subscriptions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    // "team" is intentionally excluded: subscription dispatch targets only user/org orchestrators.
    ownerType: text("owner_type", { enum: ["user", "team", "org"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    /** Event key patterns; trailing `.*` wildcard supported (e.g. "github.pull_request.*"). */
    eventKeys: jsonb("event_keys").notNull(),
    /** `{ field, op: "eq"|"in"|"prefix"|"contains", value }[]` over catalog-declared fields. */
    filters: jsonb("filters").notNull().default([]),
    /** `{ kind: "workflow", workflowId } | { kind: "orchestrator" } | { kind: "signal" }`. */
    target: jsonb("target").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [index("event_subscriptions_org_enabled").on(t.orgId, t.enabled)],
);

// Workflow schedules — cron-driven run starts (the time-based counterpart
// of `{kind:"workflow"}` event subscriptions). `next_fire_at` is
// PRECOMPUTED at write time and after every fire so the scheduler's poll
// is one indexed range scan; `cron` is a 5-field expression evaluated in
// `timezone` (IANA name, default UTC). Missed occurrences (downtime)
// collapse into ONE catch-up fire — the scheduler advances from `now`, not
// from the missed slot, so a weekend outage doesn't replay 200 runs.
export const workflowSchedules = pgTable(
  "workflow_schedules",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    ownerType: text("owner_type", { enum: ["user", "team", "org"] }).notNull().default("user"),
    ownerId: text("owner_id").notNull(),
    /** Fire target: start a workflow run, or prompt the orchestrator
     * (V1's `schedule_target=orchestrator`). `workflow_id`/`prompt` are
     * each required only for their own kind. */
    targetKind: text("target_kind", { enum: ["workflow", "orchestrator"] })
      .notNull()
      .default("workflow"),
    workflowId: text("workflow_id"),
    /** Prompt submitted to the orchestrator's "schedules" thread when
     * `target_kind = 'orchestrator'`. */
    prompt: text("prompt"),
    name: text("name").notNull(),
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    /** Optional static payload delivered as `trigger.data.input`. */
    input: jsonb("input"),
    enabled: boolean("enabled").notNull().default(true),
    lastFiredAt: bigint("last_fired_at", { mode: "number" }),
    nextFireAt: bigint("next_fire_at", { mode: "number" }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("workflow_schedules_due").on(t.enabled, t.nextFireAt),
    index("workflow_schedules_workflow").on(t.workflowId),
  ],
);

// The bearer secret IS the primary key: `id` is the opaque hookId minted
// into the trigger URL (`POST /api/hooks/workflows/:workflowId/:hookId`),
// not a surrogate row id. `workflow_id` is unique — one active hook per
// workflow — so minting again replaces the row and invalidates the old
// URL (overhaul design decision 5's "regenerable").
export const workflowWebhooks = pgTable(
  "workflow_webhooks",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id").notNull(),
    orgId: text("org_id").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("workflow_webhooks_workflow").on(t.workflowId)],
);

export const eventDeliveries = pgTable(
  "event_deliveries",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    subscriptionId: text("subscription_id").notNull(),
    status: text("status", { enum: ["pending", "delivered", "failed", "dead"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: bigint("next_attempt_at", { mode: "number" }).notNull(),
    lastError: text("last_error"),
    deliveredAt: bigint("delivered_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("event_deliveries_due").on(t.status, t.nextAttemptAt),
    index("event_deliveries_event").on(t.eventId),
  ],
);

export const linearInstallations = pgTable(
  "linear_installations",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    workspaceName: text("workspace_name").notNull(),
    webhookId: text("webhook_id"),
    connectedBy: text("connected_by").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("linear_installations_org_workspace").on(t.orgId, t.workspaceId)],
);

// ─── Inferred row types ─────────────────────────────────────────────────────

export type OrgRow = typeof orgs.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof session.$inferSelect;
export type AccountRow = typeof account.$inferSelect;
export type VerificationRow = typeof verification.$inferSelect;
export type SsoProviderRow = typeof ssoProvider.$inferSelect;
export type ApikeyRow = typeof apikey.$inferSelect;
export type OauthApplicationRow = typeof oauthApplication.$inferSelect;
export type OauthAccessTokenRow = typeof oauthAccessToken.$inferSelect;
export type OauthConsentRow = typeof oauthConsent.$inferSelect;
export type InviteRow = typeof invites.$inferSelect;
export type SandboxTokenRow = typeof sandboxTokens.$inferSelect;
export type OrgMemberRow = typeof orgMembers.$inferSelect;
export type AgentSessionRow = typeof agentSessions.$inferSelect;
export type SessionThreadRow = typeof sessionThreads.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type TeamRow = typeof teams.$inferSelect;
export type TeamMemberRow = typeof teamMembers.$inferSelect;
export type AssistantRow = typeof assistants.$inferSelect;
export type ChildWatchRow = typeof childWatches.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type UserNotificationPreferenceRow = typeof userNotificationPreferences.$inferSelect;
export type EventDropLogRow = typeof eventDropLog.$inferSelect;
export type ChannelBindingRow = typeof channelBindings.$inferSelect;
export type UserIdentityLinkRow = typeof userIdentityLinks.$inferSelect;
export type IdentityLinkCodeRow = typeof identityLinkCodes.$inferSelect;
export type ChannelActiveStreamRow = typeof channelActiveStreams.$inferSelect;
export type MemoryFileRow = typeof memoryFiles.$inferSelect;
export type SkillRow = typeof skills.$inferSelect;
/** One tracked skill repository. Not the engine's `SkillSource`. */
export type SkillSourceRow = typeof skillSources.$inferSelect;
export type WorkflowDefinitionRow = typeof workflowDefinitions.$inferSelect;
export type WorkflowRunRow = typeof workflowRuns.$inferSelect;
export type WorkflowCheckpointRow = typeof workflowCheckpoints.$inferSelect;
export type WorkflowSignalRow = typeof workflowSignals.$inferSelect;
export type CredentialRow = typeof credentials.$inferSelect;
export type ActionPolicyRow = typeof actionPolicies.$inferSelect;
export type RuntimeGrantRow = typeof runtimeGrants.$inferSelect;
export type ActionPolicyOverrideRow = typeof actionPolicyOverrides.$inferSelect;
export type ActionInvocationRow = typeof actionInvocations.$inferSelect;
export type LlmProviderRow = typeof llmProviders.$inferSelect;
export type SessionRepoRow = typeof sessionRepos.$inferSelect;
export type GithubInstallationRow = typeof githubInstallations.$inferSelect;
export type ImageSourceRow = typeof imageSources.$inferSelect;
export type BakeRow = typeof bakes.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type EventSubscriptionRow = typeof eventSubscriptions.$inferSelect;
export type EventDeliveryRow = typeof eventDeliveries.$inferSelect;
export type LinearInstallationRow = typeof linearInstallations.$inferSelect;
