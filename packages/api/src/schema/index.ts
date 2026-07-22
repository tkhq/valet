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
} from "drizzle-orm/pg-core";

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
// JSON-as-text becomes `jsonb` only where a reader `JSON.parse`s the column
// (traced via grep — see the per-column disposition table in the task
// report); everything else (e.g. `memory_files.tags`/`.extras`, which Task 9
// feeds into the tsvector generated column as text) stays `text`.
// Boolean-as-integer (`0`/`1` flags with no arithmetic) becomes `boolean`.
// `AUTOINCREMENT` becomes `generated always as identity`.

// ─── Identity ───────────────────────────────────────────────────────────────

export const orgs = pgTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // JSON object of feature flags, e.g. `{ organizations: boolean }`. Read as
  // JSON (`services/org.ts`'s `JSON.parse`/`JSON.stringify`) — jsonb.
  features: jsonb("features").notNull().default({}),
  // Ordered list of namespaced model ids (e.g. `"anthropic/claude-opus-4"`)
  // the org has opted into, most-preferred first. Read/written as JSON
  // (`services/org.ts`'s `getOrgModelPreferences`/`setOrgModelPreferences`)
  // — jsonb, mirroring the `features` column above.
  modelPreferences: jsonb("model_preferences").notNull().default([]),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
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
    // ttyd + code-server + the auth gateway inside the sandbox. Only
    // web-created interactive sessions may request "full" — orchestrator,
    // child, and workflow sessions always hardcode "headless".
    profile: text("profile", { enum: ["headless", "full"] }).notNull().default("headless"),
    // The `prebuilds.id` this session's sandbox booted from, when session
    // create resolved the primary repo binding to a `pushed` prebuild image
    // (sandbox images v2 plan, Task 4). Null for cold-start sessions (no
    // matching config/prebuild, or a `customImage: false` provider). Nullable
    // — the vast majority of sessions never resolve a prebuild.
    prebuildId: text("prebuild_id"),
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

export const teams = pgTable(
  "teams",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("teams_org_name").on(t.orgId, t.name)],
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

// ─── Orchestrator identities ────────────────────────────────────────────────
//
// One durable identity per orchestrator (user/team/org), never rotated.
// Unique per (orgId, ownerType, ownerId); handles unique per org (enforced
// in service code once handles are assigned — no logic this phase).

export const orchestratorIdentities = pgTable(
  "orchestrator_identities",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    ownerType: text("owner_type", { enum: ["user", "team", "org"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    sessionId: text("session_id").notNull(),
    handle: text("handle"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("orchestrator_identities_owner").on(t.orgId, t.ownerType, t.ownerId),
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
  },
  (t) => [
    index("child_watches_parent").on(t.parentSessionId),
    index("child_watches_settled").on(t.settled),
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
// never persisted. `scopes`/`metadata` are `JSON.parse`'d by
// `plugins/credential-store.ts` — jsonb.

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
  metadata: jsonb("metadata"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

// `action_invocations` — durable dedup table for the workflow `tool` node's
// `invokeAction` seam (plugin-system-v2 plan Task 6). `result` is
// `JSON.stringify`'d by `plugins/action-invoker.ts` and `JSON.parse`'d back
// — jsonb. A duplicate `invocationId` (crash-and-retry, concurrent
// dispatch) reads back the original row rather than re-invoking the action.
export const actionInvocations = pgTable("action_invocations", {
  invocationId: text("invocation_id").primaryKey(),
  result: jsonb("result").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

// ─── LLM providers (org BYO keys + custom providers) ────────────────────────
//
// One row per org-configured LLM provider. The three known kinds
// (`anthropic`/`openai`/`google`) are per-org singletons — enforced here via
// a partial unique index (Drizzle's pg-core has no portable way to express
// a `WHERE` clause on a `uniqueIndex()`, so it's declared in
// `migrations/pg/0000_app.sql` directly) AND in `services/org.ts` /
// the Task 3-5 provider service (the service-layer check is the one tests
// pin — see task brief). `openai_compatible` rows are custom providers and
// may have any number per org. `models` is only populated for
// `openai_compatible` providers (known kinds resolve their model list from
// the engine's built-in catalog) — read/written as JSON, jsonb per the
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
      enum: ["anthropic", "openai", "google", "openai_compatible"],
    }).notNull(),
    name: text("name").notNull(),
    baseUrl: text("base_url"),
    enabled: boolean("enabled").notNull().default(true),
    models: jsonb("models").notNull().default([]).$type<LlmProviderModel[]>(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("llm_providers_org").on(t.orgId)],
);

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

// ─── Sandbox image prebuilds (sandbox images v2 plan, Task 1) ──────────────
//
// Three tables: `image_catalog` (admin-registered base images an org can
// pin a prebuild config to), `prebuild_configs` (one row per repo an org
// has opted into nightly/manual prebuilds for), `prebuilds` (one row per
// build attempt — `recipe` snapshots the RESOLVED `RecipeStep[]` at build
// time, per `packages/api/src/prebuilds/recipe.ts`, so a later change to
// detection logic never retroactively changes what an already-built image
// claims to contain).

export const imageCatalog = pgTable(
  "image_catalog",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    ref: text("ref").notNull(),
    pullSecretName: text("pull_secret_name"),
    kind: text("kind", { enum: ["base"] })
      .notNull()
      .default("base"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("image_catalog_org").on(t.orgId)],
);

export const prebuildConfigs = pgTable(
  "prebuild_configs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    repoHost: text("repo_host").notNull().default("github"),
    repoFullName: text("repo_full_name").notNull(),
    cloneUrl: text("clone_url").notNull(),
    baseImageId: text("base_image_id"),
    schedule: text("schedule", { enum: ["nightly", "off"] })
      .notNull()
      .default("nightly"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("prebuild_configs_org").on(t.orgId),
    uniqueIndex("prebuild_configs_org_repo").on(t.orgId, t.repoHost, t.repoFullName),
  ],
);

export const prebuilds = pgTable(
  "prebuilds",
  {
    id: text("id").primaryKey(),
    configId: text("config_id").notNull(),
    commitSha: text("commit_sha").notNull(),
    imageRef: text("image_ref").notNull(),
    status: text("status", {
      enum: ["queued", "building", "pushed", "failed"],
    }).notNull(),
    builderBackend: text("builder_backend").notNull(),
    recipe: jsonb("recipe").notNull(),
    error: text("error"),
    logTail: text("log_tail"),
    startedAt: bigint("started_at", { mode: "number" }),
    finishedAt: bigint("finished_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("prebuilds_config_status_created").on(t.configId, t.status, t.createdAt)],
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
    ownerType: text("owner_type", { enum: ["user", "org"] }).notNull(),
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
export type OrchestratorIdentityRow = typeof orchestratorIdentities.$inferSelect;
export type ChildWatchRow = typeof childWatches.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type UserNotificationPreferenceRow = typeof userNotificationPreferences.$inferSelect;
export type EventDropLogRow = typeof eventDropLog.$inferSelect;
export type ChannelBindingRow = typeof channelBindings.$inferSelect;
export type UserIdentityLinkRow = typeof userIdentityLinks.$inferSelect;
export type IdentityLinkCodeRow = typeof identityLinkCodes.$inferSelect;
export type MemoryFileRow = typeof memoryFiles.$inferSelect;
export type WorkflowDefinitionRow = typeof workflowDefinitions.$inferSelect;
export type WorkflowRunRow = typeof workflowRuns.$inferSelect;
export type WorkflowCheckpointRow = typeof workflowCheckpoints.$inferSelect;
export type WorkflowSignalRow = typeof workflowSignals.$inferSelect;
export type CredentialRow = typeof credentials.$inferSelect;
export type ActionInvocationRow = typeof actionInvocations.$inferSelect;
export type LlmProviderRow = typeof llmProviders.$inferSelect;
export type SessionRepoRow = typeof sessionRepos.$inferSelect;
export type GithubInstallationRow = typeof githubInstallations.$inferSelect;
export type ImageCatalogRow = typeof imageCatalog.$inferSelect;
export type PrebuildConfigRow = typeof prebuildConfigs.$inferSelect;
export type PrebuildRow = typeof prebuilds.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type EventSubscriptionRow = typeof eventSubscriptions.$inferSelect;
export type EventDeliveryRow = typeof eventDeliveries.$inferSelect;
export type LinearInstallationRow = typeof linearInstallations.$inferSelect;
