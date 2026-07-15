import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, primaryKey, uniqueIndex } from "drizzle-orm/sqlite-core";

// ─── Identity ───────────────────────────────────────────────────────────────

export const orgs = sqliteTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // JSON object of feature flags, e.g. `{ organizations: boolean }`. Absent
  // key reads as false (split-settings design, "Feature gate").
  features: text("features").notNull().default("{}"),
  createdAt: integer("created_at").notNull(),
});

// better-auth's default model name for the user table is "user" (singular);
// we keep the Drizzle export name `users` so existing call sites still
// compile, but the underlying sqlite table is named "user" — do not fight
// better-auth with model remapping (auth-v2 design, Schema).
export const users = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).default(false).notNull(),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  role: text("role", { enum: ["admin", "member"] }).notNull().default("member"),
  // Nullable user preference feeding `EngineHost`'s model override seam;
  // null falls back to the host default (split-settings design, decision 9).
  defaultModel: text("default_model"),
});

// ─── better-auth core + plugin tables ───────────────────────────────────────
//
// Verbatim transcription of the better-auth CLI-generated schema for our
// enabled plugins (core, sso, api-key, oidc-provider) — see auth-v2 design
// §Schema. Do not hand-tune column shapes here; regenerate via
// `npx @better-auth/cli generate` against `auth.ts` and diff instead.

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_userId_idx").on(t.userId)],
);

export const account = sqliteTable(
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
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (t) => [index("account_userId_idx").on(t.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

export const ssoProvider = sqliteTable("sso_provider", {
  id: text("id").primaryKey(),
  issuer: text("issuer").notNull(),
  oidcConfig: text("oidc_config"),
  samlConfig: text("saml_config"),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  providerId: text("provider_id").notNull().unique(),
  organizationId: text("organization_id"),
  domain: text("domain").notNull(),
});

export const apikey = sqliteTable(
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
    lastRefillAt: integer("last_refill_at", { mode: "timestamp_ms" }),
    enabled: integer("enabled", { mode: "boolean" }).default(true),
    rateLimitEnabled: integer("rate_limit_enabled", { mode: "boolean" }).default(true),
    rateLimitTimeWindow: integer("rate_limit_time_window").default(86400000),
    rateLimitMax: integer("rate_limit_max").default(10),
    requestCount: integer("request_count").default(0),
    remaining: integer("remaining"),
    lastRequest: integer("last_request", { mode: "timestamp_ms" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    permissions: text("permissions"),
    metadata: text("metadata"),
  },
  (t) => [
    index("apikey_configId_idx").on(t.configId),
    index("apikey_referenceId_idx").on(t.referenceId),
    index("apikey_key_idx").on(t.key),
  ],
);

export const oauthApplication = sqliteTable(
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
    disabled: integer("disabled", { mode: "boolean" }).default(false),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("oauthApplication_userId_idx").on(t.userId)],
);

export const oauthAccessToken = sqliteTable(
  "oauth_access_token",
  {
    id: text("id").primaryKey(),
    accessToken: text("access_token").unique(),
    refreshToken: text("refresh_token").unique(),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    clientId: text("client_id").references(() => oauthApplication.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    scopes: text("scopes"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("oauthAccessToken_clientId_idx").on(t.clientId),
    index("oauthAccessToken_userId_idx").on(t.userId),
  ],
);

export const oauthConsent = sqliteTable(
  "oauth_consent",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").references(() => oauthApplication.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    scopes: text("scopes"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
    consentGiven: integer("consent_given", { mode: "boolean" }),
  },
  (t) => [
    index("oauthConsent_clientId_idx").on(t.clientId),
    index("oauthConsent_userId_idx").on(t.userId),
  ],
);

// ─── Valet-owned auth adjuncts ──────────────────────────────────────────────

export const invites = sqliteTable("invites", {
  id: text("id").primaryKey(),
  codeHash: text("code_hash").notNull().unique(),
  email: text("email"),
  role: text("role", { enum: ["admin", "member"] }).notNull().default("member"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  acceptedBy: text("accepted_by"),
  acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
});

export const sandboxTokens = sqliteTable("sandbox_tokens", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  sessionId: text("session_id").notNull(),
  userId: text("user_id").notNull(),
  orgId: text("org_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
});

export const orgMembers = sqliteTable(
  "org_members",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role", { enum: ["admin", "member"] }).notNull(),
    createdAt: integer("created_at"),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

// ─── Agent sessions ─────────────────────────────────────────────────────────
//
// One row per session the user creates from the UI. The engine maintains its
// own internal state in `engine_sessions`/`engine_threads`/`engine_entries`
// (managed by @valet/store-sqlite). This table holds only what the UI cares
// about: human-visible metadata, workspace path, status.

export const agentSessions = sqliteTable(
  "agent_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    workspace: text("workspace").notNull(),
    title: text("title"),
    status: text("status", {
      enum: ["active", "archived", "deleted"],
    })
      .notNull()
      .default("active"),
    // Principal ownership (decision 8/20 — engine v2). Default 'user'/''
    // matches pre-owner rows; routes that create sessions should populate
    // both explicitly (owner_id = user_id for today's user-owned sessions).
    ownerType: text("owner_type").notNull().default("user"),
    ownerId: text("owner_id").notNull().default(""),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("agent_sessions_user").on(t.userId),
    index("agent_sessions_status").on(t.status),
  ],
);

// Threads — the UI groups messages by thread. The engine has its own thread
// concept too; here we mirror just the fields the chat list needs.
export const sessionThreads = sqliteTable(
  "session_threads",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    title: text("title"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("session_threads_session").on(t.sessionId)],
);

// Messages — the visible chat log. Each row is a single message the UI
// renders. `parts` is JSON-encoded MessagePart[] (text/tool_use/tool_result).
// `content` is the flat-string projection for legacy/simple consumers.
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    threadId: text("thread_id"),
    role: text("role", {
      enum: ["user", "assistant", "system", "tool"],
    }).notNull(),
    content: text("content").notNull(),
    parts: text("parts"),
    authorId: text("author_id"),
    createdAt: integer("created_at").notNull(),
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

export const teams = sqliteTable(
  "teams",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("teams_org_name").on(t.orgId, t.name)],
);

export const teamMembers = sqliteTable(
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

export const orchestratorIdentities = sqliteTable(
  "orchestrator_identities",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    ownerType: text("owner_type", { enum: ["user", "team", "org"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    sessionId: text("session_id").notNull(),
    handle: text("handle"),
    createdAt: integer("created_at").notNull(),
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
// mechanism for `child.settled` reporting.

export const childWatches = sqliteTable(
  "child_watches",
  {
    childSessionId: text("child_session_id").primaryKey(),
    queueItemId: text("queue_item_id").notNull(),
    parentSessionId: text("parent_session_id").notNull(),
    parentThreadId: text("parent_thread_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    orgId: text("org_id").notNull(),
    settled: integer("settled").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("child_watches_parent").on(t.parentSessionId),
    index("child_watches_settled").on(t.settled),
  ],
);

// ─── Notifications + preferences ────────────────────────────────────────────

export const notifications = sqliteTable(
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
    createdAt: integer("created_at").notNull(),
    readAt: integer("read_at"),
  },
  (t) => [index("notifications_user_read").on(t.userId, t.readAt)],
);

export const userNotificationPreferences = sqliteTable(
  "user_notification_preferences",
  {
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    web: integer("web").notNull().default(1),
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

export const eventDropLog = sqliteTable(
  "event_drop_log",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    reason: text("reason").notNull(),
    conversationKey: text("conversation_key"),
    detail: text("detail").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("event_drop_log_org").on(t.orgId)],
);

// ─── Channel bindings + identity links ──────────────────────────────────────
//
// Shapes only (orchestrator spec, "Channel Bindings and Routing") — no
// routing logic lands this phase (Phase 6). One binding per external
// conversation per org is the hard uniqueness rule.

export const channelBindings = sqliteTable(
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
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("channel_bindings_conversation").on(t.orgId, t.channelType, t.conversationKey),
  ],
);

export const userIdentityLinks = sqliteTable(
  "user_identity_links",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("user_identity_links_provider_external").on(t.provider, t.externalId)],
);

// ─── Memory (OKF) ────────────────────────────────────────────────────────────
//
// Owner-tuple scoped memory store (decision 13, exact). `memory_files_fts`
// is a virtual FTS5 table — Drizzle can't model virtual tables, so it's
// created via raw SQL in the 0000 migration and intentionally has no
// Drizzle table definition here. The Task 5 FTS sync helper reads/writes it
// directly via the raw sqlite handle.

export const memoryFiles = sqliteTable(
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
    expires: integer("expires"),
    pinned: integer("pinned").notNull().default(0),
    actorUserId: text("actor_user_id").notNull().default(""),
    sourceSessionId: text("source_session_id").notNull().default(""),
    orgId: text("org_id").notNull().default(""),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
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
// sqlite-store.ts` implements the port over these three tables plus
// `workflow_definitions`). JSON columns (`definition`, `params`,
// `waiting_on`, `result`, `effects`, `payload`, `consumed_by`) are
// JSON.stringify'd text — no native JSON column type in this sqlite setup.

export const workflowDefinitions = sqliteTable(
  "workflow_definitions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    ownerType: text("owner_type", { enum: ["user", "team", "org"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    definition: text("definition").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("workflow_definitions_owner").on(t.orgId, t.ownerType, t.ownerId)],
);

export const workflowRuns = sqliteTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id").notNull(),
    definitionVersionId: text("definition_version_id").notNull(),
    definition: text("definition").notNull(),
    params: text("params").notNull(),
    status: text("status", {
      enum: ["pending", "running", "parked", "terminalizing", "settled"],
    })
      .notNull()
      .default("pending"),
    outcome: text("outcome", { enum: ["completed", "failed", "cancelled"] }),
    waitingOn: text("waiting_on").notNull().default("[]"),
    wakeAt: integer("wake_at"),
    wakeRequested: integer("wake_requested").notNull().default(0),
    // Named `lease_owner_id` (not `owner_id`) to avoid clashing with the
    // principal-ownership `owner_type`/`owner_id` columns below (plan
    // decision 17).
    leaseOwnerId: text("lease_owner_id"),
    leaseExpiresAt: integer("lease_expires_at"),
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
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("workflow_runs_status_updated").on(t.status, t.updatedAt),
    index("workflow_runs_workflow").on(t.workflowId),
  ],
);

export const workflowCheckpoints = sqliteTable(
  "workflow_checkpoints",
  {
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    iteration: integer("iteration").notNull().default(0),
    attempt: integer("attempt").notNull(),
    status: text("status", {
      enum: ["intent", "completed", "failed", "skipped"],
    }).notNull(),
    result: text("result"),
    effects: text("effects"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.nodeId, t.iteration] }),
    index("workflow_checkpoints_run").on(t.runId),
  ],
);

export const workflowSignals = sqliteTable(
  "workflow_signals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id").notNull(),
    signalId: text("signal_id").notNull(),
    signalType: text("signal_type").notNull(),
    payload: text("payload"),
    createdAt: integer("created_at").notNull(),
    consumedAt: integer("consumed_at"),
    consumedBy: text("consumed_by"),
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
// never persisted. `scopes`/`metadata` are JSON text, same convention as
// the workflow tables above.

export const credentials = sqliteTable(
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
    expiresAt: integer("expires_at"),
    scopes: text("scopes"),
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.ownerType, t.ownerId, t.service] })],
);

// `action_invocations` — durable dedup table for the workflow `tool` node's
// `invokeAction` seam (plugin-system-v2 plan Task 6). `result` is the
// JSON-serialized `WorkflowInvokeActionResult`; a duplicate `invocationId`
// (crash-and-retry, concurrent dispatch) reads back the original row rather
// than re-invoking the action.
export const actionInvocations = sqliteTable("action_invocations", {
  invocationId: text("invocation_id").primaryKey(),
  result: text("result").notNull(),
  createdAt: integer("created_at").notNull(),
});

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
export type MemoryFileRow = typeof memoryFiles.$inferSelect;
export type WorkflowDefinitionRow = typeof workflowDefinitions.$inferSelect;
export type WorkflowRunRow = typeof workflowRuns.$inferSelect;
export type WorkflowCheckpointRow = typeof workflowCheckpoints.$inferSelect;
export type WorkflowSignalRow = typeof workflowSignals.$inferSelect;
export type CredentialRow = typeof credentials.$inferSelect;
export type ActionInvocationRow = typeof actionInvocations.$inferSelect;
