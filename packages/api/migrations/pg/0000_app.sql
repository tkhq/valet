CREATE TABLE "orgs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"model_preferences" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sso_team_groups" jsonb,
	"created_at" bigint NOT NULL,
	"bare_skill_commands" boolean NOT NULL DEFAULT false,
	"allow_public_artifacts" boolean NOT NULL DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"default_model" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_unique" ON "user" ("email");
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	FOREIGN KEY ("user_id") REFERENCES "user"("id") ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_unique" ON "session" ("token");
--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" ("user_id");
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	FOREIGN KEY ("user_id") REFERENCES "user"("id") ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" ("user_id");
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");
--> statement-breakpoint
CREATE TABLE "sso_provider" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"oidc_config" text,
	"saml_config" text,
	"user_id" text,
	"provider_id" text NOT NULL,
	"organization_id" text,
	"domain" text NOT NULL,
	FOREIGN KEY ("user_id") REFERENCES "user"("id") ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sso_provider_providerId_unique" ON "sso_provider" ("provider_id");
--> statement-breakpoint
CREATE TABLE "apikey" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text DEFAULT 'default' NOT NULL,
	"name" text,
	"start" text,
	"reference_id" text NOT NULL,
	"prefix" text,
	"key" text NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp,
	"enabled" boolean DEFAULT true,
	"rate_limit_enabled" boolean DEFAULT true,
	"rate_limit_time_window" integer DEFAULT 86400000,
	"rate_limit_max" integer DEFAULT 10,
	"request_count" integer DEFAULT 0,
	"remaining" integer,
	"last_request" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"permissions" text,
	"metadata" text
);
--> statement-breakpoint
CREATE INDEX "apikey_configId_idx" ON "apikey" ("config_id");
--> statement-breakpoint
CREATE INDEX "apikey_referenceId_idx" ON "apikey" ("reference_id");
--> statement-breakpoint
CREATE INDEX "apikey_key_idx" ON "apikey" ("key");
--> statement-breakpoint
CREATE TABLE "oauth_application" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"icon" text,
	"metadata" text,
	"client_id" text,
	"client_secret" text,
	"redirect_urls" text,
	"type" text,
	"disabled" boolean DEFAULT false,
	"user_id" text,
	"created_at" timestamp,
	"updated_at" timestamp,
	FOREIGN KEY ("user_id") REFERENCES "user"("id") ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_application_clientId_unique" ON "oauth_application" ("client_id");
--> statement-breakpoint
CREATE INDEX "oauthApplication_userId_idx" ON "oauth_application" ("user_id");
--> statement-breakpoint
CREATE TABLE "oauth_access_token" (
	"id" text PRIMARY KEY NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"client_id" text,
	"user_id" text,
	"scopes" text,
	"created_at" timestamp,
	"updated_at" timestamp,
	FOREIGN KEY ("client_id") REFERENCES "oauth_application"("client_id") ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY ("user_id") REFERENCES "user"("id") ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_access_token_accessToken_unique" ON "oauth_access_token" ("access_token");
--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_access_token_refreshToken_unique" ON "oauth_access_token" ("refresh_token");
--> statement-breakpoint
CREATE INDEX "oauthAccessToken_clientId_idx" ON "oauth_access_token" ("client_id");
--> statement-breakpoint
CREATE INDEX "oauthAccessToken_userId_idx" ON "oauth_access_token" ("user_id");
--> statement-breakpoint
CREATE TABLE "oauth_consent" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text,
	"user_id" text,
	"scopes" text,
	"created_at" timestamp,
	"updated_at" timestamp,
	"consent_given" boolean,
	FOREIGN KEY ("client_id") REFERENCES "oauth_application"("client_id") ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY ("user_id") REFERENCES "user"("id") ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "oauthConsent_clientId_idx" ON "oauth_consent" ("client_id");
--> statement-breakpoint
CREATE INDEX "oauthConsent_userId_idx" ON "oauth_consent" ("user_id");
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"email" text,
	"role" text DEFAULT 'member' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	"accepted_by" text,
	"accepted_at" timestamp
);
--> statement-breakpoint
CREATE UNIQUE INDEX "invites_code_hash_unique" ON "invites" ("code_hash");
--> statement-breakpoint
CREATE INDEX "idx_invites_email" ON "invites" ("email");
--> statement-breakpoint
CREATE TABLE "sandbox_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_tokens_token_hash_unique" ON "sandbox_tokens" ("token_hash");
--> statement-breakpoint
CREATE INDEX "idx_sandbox_tokens_hash" ON "sandbox_tokens" ("token_hash");
--> statement-breakpoint
CREATE TABLE "org_members" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" bigint,
	PRIMARY KEY("org_id", "user_id")
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"workspace" text NOT NULL,
	"title" text,
	"status" text DEFAULT 'active' NOT NULL,
	"owner_type" text DEFAULT 'user' NOT NULL,
	"owner_id" text DEFAULT '' NOT NULL,
	"profile" text DEFAULT 'headless' NOT NULL,
	"docker" boolean DEFAULT false NOT NULL,
	"kind" text DEFAULT 'code' NOT NULL,
	"bake_id" text,
	"hibernated_sandbox_id" text,
	"sandbox_reclaimed_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_sessions_user" ON "agent_sessions" ("user_id");
--> statement-breakpoint
CREATE INDEX "agent_sessions_status" ON "agent_sessions" ("status");
--> statement-breakpoint
CREATE TABLE "session_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"title" text,
	"created_at" bigint NOT NULL,
	"archived_at" bigint
);
--> statement-breakpoint
CREATE INDEX "session_threads_session" ON "session_threads" ("session_id");
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"thread_id" text,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"parts" jsonb,
	"author_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "messages_session" ON "messages" ("session_id");
--> statement-breakpoint
CREATE INDEX "messages_thread" ON "messages" ("thread_id");
--> statement-breakpoint
CREATE INDEX "messages_created" ON "messages" ("created_at");
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"origin" text DEFAULT 'local' NOT NULL,
	"external_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "teams_org_name" ON "teams" ("org_id","name");
--> statement-breakpoint
CREATE UNIQUE INDEX "teams_org_external" ON "teams" ("org_id","origin","external_id");
--> statement-breakpoint
CREATE TABLE "team_members" (
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	PRIMARY KEY("team_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX "team_members_user" ON "team_members" ("user_id");
--> statement-breakpoint
CREATE TABLE "assistants" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"name" text,
	"session_id" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"archived_at" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX "assistants_session" ON "assistants" ("session_id");
--> statement-breakpoint
-- Exactly one default per principal. PARTIAL, not a plain unique: every
-- non-default assistant shares the same (org, owner_type, owner_id), so a
-- full unique index would allow only one assistant per principal — the very
-- rule this table exists to remove.
CREATE UNIQUE INDEX "assistants_default_owner" ON "assistants" ("org_id","owner_type","owner_id") WHERE "is_default";
--> statement-breakpoint
CREATE INDEX "assistants_owner" ON "assistants" ("org_id","owner_type","owner_id");
--> statement-breakpoint
CREATE TABLE "child_watches" (
	"child_session_id" text PRIMARY KEY NOT NULL,
	"queue_item_id" text NOT NULL,
	"parent_session_id" text NOT NULL,
	"parent_thread_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"settled" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"dismissed_at" bigint,
	"settled_at" bigint,
	"sandbox_reclaimed_at" bigint,
	"parked_sandbox_id" text
);
--> statement-breakpoint
CREATE INDEX "child_watches_parent" ON "child_watches" ("parent_session_id");
--> statement-breakpoint
CREATE INDEX "child_watches_settled" ON "child_watches" ("settled");
--> statement-breakpoint
CREATE INDEX "child_watches_retention" ON "child_watches" ("settled_at") WHERE "settled" = true AND "sandbox_reclaimed_at" IS NULL;
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"urgency" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"href" text,
	"session_id" text,
	"created_at" bigint NOT NULL,
	"read_at" bigint
);
--> statement-breakpoint
CREATE INDEX "notifications_user_read" ON "notifications" ("user_id","read_at");
--> statement-breakpoint
CREATE TABLE "user_notification_preferences" (
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"web" boolean DEFAULT true NOT NULL,
	PRIMARY KEY("user_id", "kind")
);
--> statement-breakpoint
CREATE TABLE "event_drop_log" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"reason" text NOT NULL,
	"conversation_key" text,
	"detail" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "event_drop_log_org" ON "event_drop_log" ("org_id");
--> statement-breakpoint
CREATE TABLE "channel_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"channel_type" text NOT NULL,
	"conversation_key" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"session_id" text NOT NULL,
	"thread_key_template" text NOT NULL,
	"queue_mode" text NOT NULL,
	"trigger_mode" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "channel_bindings_conversation" ON "channel_bindings" ("org_id","channel_type","conversation_key");
--> statement-breakpoint
CREATE TABLE "user_identity_links" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"notify_attention" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_identity_links_provider_external" ON "user_identity_links" ("provider","external_id");
--> statement-breakpoint
CREATE TABLE "identity_link_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "identity_link_codes_provider" ON "identity_link_codes" ("provider","code_hash");
--> statement-breakpoint
-- Open streaming messages, one row per provider stream the api has started
-- and not yet stopped. The engine's `text_delta` plane is ephemeral: it is
-- never appended to the event log and is never replayed. So an api that dies
-- mid-stream cannot reconstruct the text, and the reader is left with a
-- message that shimmers forever. This table is the only durable trace of
-- "a stream is open", and it exists so the next boot can close it.
--
-- Not Slack-specific: any transport that implements the start/append/stop
-- triple gets swept by the same code.
CREATE TABLE "channel_active_streams" (
	"channel_type" text NOT NULL,
	"conversation_key" text NOT NULL,
	"message_id" text NOT NULL,
	"thread_ts" text NOT NULL,
	"session_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"engine_message_id" text,
	"org_id" text NOT NULL,
	"started_at" bigint NOT NULL,
	CONSTRAINT "channel_active_streams_pk" PRIMARY KEY("channel_type","conversation_key","message_id")
);
--> statement-breakpoint
CREATE INDEX "channel_active_streams_started" ON "channel_active_streams" ("started_at");
--> statement-breakpoint
CREATE TABLE "memory_files" (
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"path" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"content" text NOT NULL,
	"type" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"tags" text DEFAULT '[]' NOT NULL,
	"resource" text DEFAULT '' NOT NULL,
	"extras" text DEFAULT '{}' NOT NULL,
	"sensitivity" text DEFAULT 'private' NOT NULL,
	"origin" text DEFAULT '' NOT NULL,
	"expires" bigint,
	"pinned" boolean DEFAULT false NOT NULL,
	"actor_user_id" text DEFAULT '' NOT NULL,
	"source_session_id" text DEFAULT '' NOT NULL,
	"org_id" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	PRIMARY KEY("owner_type", "owner_id", "path")
);
--> statement-breakpoint
-- `search_vector` generated column (spec decision 9): weighted tsvector,
-- computed automatically by Postgres on every INSERT/UPDATE — the manual
-- fts5-sync helper (`syncFts` in services/memory.ts) is deleted in Task 9,
-- which ports the memory service off this manual sync onto this column.
-- Weights: A=title, B=description, C=path+tags (concatenated as text — see
-- the "tags stays text" note in schema/index.pg.ts), D=content. `path` gets
-- its own weight class (C, shared with tags) rather than collapsing into
-- `content`'s class (D) — a path-term match must rank above a body mention,
-- matching bm25's old per-column weights (path 5, content 1) which never
-- shared a class either.
-- `path`/`tags` are run through `regexp_replace(..., '[^a-zA-Z0-9]+', ' ', 'g')`
-- before `to_tsvector` — without it, Postgres's parser classifies a
-- slash-containing string like `instruments/xylophone/setup.md` as a single
-- "file"-type token (`'instruments/xylophone/setup.md':2C`, verified by
-- inspecting the raw tsvector in a scratch PGlite instance) instead of
-- splitting it into searchable words, so a path-term query would never
-- match at all. The regexp explodes both path segments and the
-- `tags` column's JSON-array punctuation (`["a","b"]`) into space-separated
-- words the parser tokenizes normally.
ALTER TABLE "memory_files" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (
	setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
	setweight(to_tsvector('english', coalesce("description", '')), 'B') ||
	setweight(to_tsvector('english', regexp_replace(coalesce("path", '') || ' ' || coalesce("tags", ''), '[^a-zA-Z0-9]+', ' ', 'g')), 'C') ||
	setweight(to_tsvector('english', coalesce("content", '')), 'D')
) STORED;
--> statement-breakpoint
CREATE INDEX "memory_files_search_vector_idx" ON "memory_files" USING gin ("search_vector");
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"org_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"source_session_id" text DEFAULT '' NOT NULL,
	"source_memory_path" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"content" text NOT NULL,
	"visibility" text DEFAULT 'org' NOT NULL,
	"public_by" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"revoked_at" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_token_unique" ON "artifacts" ("token");
--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_owner_path_unique" ON "artifacts" ("owner_type","owner_id","source_memory_path");
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"origin" text NOT NULL,
	"source_id" text,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"content" text NOT NULL,
	"frontmatter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_sha" text NOT NULL,
	"upstream_path" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "skills_owner" ON "skills" ("org_id","owner_type","owner_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "skills_owner_name" ON "skills" ("org_id","owner_type","owner_id","name");
--> statement-breakpoint
CREATE TABLE "skill_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"created_by" text,
	"repo_full_name" text NOT NULL,
	"ref" text DEFAULT '' NOT NULL,
	"subpath" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" bigint NOT NULL,
	"last_sha" text,
	"last_manifest_hash" text,
	"last_synced_at" bigint,
	"last_error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "skill_sources_owner" ON "skill_sources" ("org_id","owner_type","owner_id");
--> statement-breakpoint
CREATE INDEX "skill_sources_due" ON "skill_sources" ("enabled","next_attempt_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "skill_sources_repo" ON "skill_sources" ("org_id","owner_type","owner_id","repo_full_name","subpath");
--> statement-breakpoint
CREATE TABLE "workflow_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "workflow_definitions_owner" ON "workflow_definitions" ("org_id","owner_type","owner_id");
--> statement-breakpoint
CREATE TABLE "workflow_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_versions_wf_version" ON "workflow_versions" ("workflow_id","version");
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"definition_version_id" text NOT NULL,
	"definition" jsonb NOT NULL,
	"params" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"outcome" text,
	"waiting_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"wake_at" bigint,
	"wake_requested" boolean DEFAULT false NOT NULL,
	"lease_owner_id" text,
	"lease_expires_at" bigint,
	"attempt" integer DEFAULT 0 NOT NULL,
	"owner_type" text DEFAULT 'user' NOT NULL,
	"owner_id" text DEFAULT '' NOT NULL,
	"sandbox_reclaimed_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "workflow_runs_status_updated" ON "workflow_runs" ("status","updated_at");
--> statement-breakpoint
CREATE INDEX "workflow_runs_workflow" ON "workflow_runs" ("workflow_id");
--> statement-breakpoint
CREATE TABLE "workflow_checkpoints" (
	"run_id" text NOT NULL,
	"node_id" text NOT NULL,
	"iteration" integer DEFAULT 0 NOT NULL,
	"attempt" integer NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"effects" jsonb,
	"error" text,
	"created_at" bigint NOT NULL,
	PRIMARY KEY("run_id", "node_id", "iteration")
);
--> statement-breakpoint
CREATE INDEX "workflow_checkpoints_run" ON "workflow_checkpoints" ("run_id");
--> statement-breakpoint
CREATE TABLE "workflow_signals" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY NOT NULL,
	"run_id" text NOT NULL,
	"signal_id" text NOT NULL,
	"signal_type" text NOT NULL,
	"payload" jsonb,
	"created_at" bigint NOT NULL,
	"consumed_at" bigint,
	"consumed_by" jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_signals_run_signal" ON "workflow_signals" ("run_id","signal_id");
--> statement-breakpoint
CREATE INDEX "workflow_signals_run" ON "workflow_signals" ("run_id");
--> statement-breakpoint
CREATE TABLE "credentials" (
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"service" text NOT NULL,
	"type" text NOT NULL,
	"access_token_enc" text,
	"refresh_token_enc" text,
	"api_key_enc" text,
	"expires_at" bigint,
	"scopes" jsonb,
	"metadata" jsonb,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	PRIMARY KEY("owner_type", "owner_id", "service")
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_clients" (
	"service" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_enc" text,
	"authorization_endpoint" text NOT NULL,
	"token_endpoint" text NOT NULL,
	"registration_endpoint" text,
	"registered_scopes" jsonb,
	"scopes_supported" jsonb,
	"metadata" jsonb,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "action_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"service" text,
	"action_id" text,
	"risk_level" text,
	"mode" text NOT NULL,
	"param_matchers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"applies_in" text DEFAULT 'any' NOT NULL,
	"origin" text NOT NULL,
	"managed_by" text,
	"expires_at" bigint,
	"revoked_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "action_policies_one_of_target" CHECK ((("service" IS NOT NULL)::int + ("action_id" IS NOT NULL)::int + ("risk_level" IS NOT NULL)::int) = 1)
);
--> statement-breakpoint
CREATE INDEX "action_policies_org_revoked" ON "action_policies" ("org_id","revoked_at");
--> statement-breakpoint
CREATE TABLE "runtime_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"session_id" text,
	"workflow_execution_id" text,
	"policy_key" text NOT NULL,
	"mode" text DEFAULT 'allow' NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"revoked_at" bigint,
	CONSTRAINT "runtime_grants_one_of_scope" CHECK ((("session_id" IS NOT NULL)::int + ("workflow_execution_id" IS NOT NULL)::int) = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_grants_session_policy_key" ON "runtime_grants" ("org_id","session_id","policy_key") WHERE "session_id" IS NOT NULL AND "revoked_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_grants_execution_policy_key" ON "runtime_grants" ("org_id","workflow_execution_id","policy_key") WHERE "workflow_execution_id" IS NOT NULL AND "revoked_at" IS NULL;
--> statement-breakpoint
CREATE TABLE "action_policy_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"service" text,
	"action_id" text,
	"risk_level" text,
	"mode" text NOT NULL,
	"param_matchers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "action_policy_overrides_one_of_target" CHECK ((("service" IS NOT NULL)::int + ("action_id" IS NOT NULL)::int + ("risk_level" IS NOT NULL)::int) = 1)
);
--> statement-breakpoint
CREATE INDEX "action_policy_overrides_org_user" ON "action_policy_overrides" ("org_id","user_id");
--> statement-breakpoint
CREATE TABLE "action_invocations" (
	"invocation_id" text PRIMARY KEY NOT NULL,
	"result" jsonb,
	"result_truncated" boolean,
	"created_at" bigint NOT NULL,
	"service" text,
	"action_id" text,
	"risk_level" text,
	"resolved_mode" text,
	"base_mode" text,
	"matched_policy_id" text,
	"matched_grant_id" text,
	"matched_override_id" text,
	"status" text,
	"session_id" text,
	"workflow_execution_id" text,
	"user_id" text,
	"org_id" text,
	"params" jsonb,
	"params_truncated" boolean,
	"duration_ms" bigint,
	"error" text,
	"started_at" bigint,
	"resolved_by" text
);
--> statement-breakpoint
CREATE INDEX "action_invocations_session" ON "action_invocations" ("session_id");
--> statement-breakpoint
CREATE INDEX "action_invocations_org_created" ON "action_invocations" ("org_id","created_at");
--> statement-breakpoint
CREATE TABLE "llm_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "llm_providers_org" ON "llm_providers" ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "llm_providers_org_kind_singleton" ON "llm_providers" ("org_id","kind") WHERE "kind" <> 'openai_compatible';
--> statement-breakpoint
CREATE TABLE "session_repos" (
	"session_id" text NOT NULL,
	"host" text DEFAULT 'github' NOT NULL,
	"full_name" text NOT NULL,
	"clone_url" text NOT NULL,
	"ref" text,
	"auth" text DEFAULT 'auto' NOT NULL,
	"position" integer NOT NULL,
	"target_dir" text
);
--> statement-breakpoint
CREATE INDEX "session_repos_session" ON "session_repos" ("session_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "session_repos_session_position" ON "session_repos" ("session_id","position");
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"installation_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"repository_selection" text,
	"suspended" boolean DEFAULT false NOT NULL,
	"linked_user_id" text,
	"cached_token" text,
	"cached_token_expires_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "github_installations_org_installation" ON "github_installations" ("org_id","installation_id");
--> statement-breakpoint
CREATE INDEX "github_installations_org_account" ON "github_installations" ("org_id","account_login");
--> statement-breakpoint
CREATE TABLE "image_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL CHECK (kind IN ('external','base','repo')),
	"parent_id" text REFERENCES image_sources(id),
	"name" text NOT NULL,
	"external_ref" text,
	"pull_secret_name" text,
	"setup_commands" jsonb,
	"profile" text CHECK (profile IS NULL OR profile IN ('headless','full')),
	"repo_host" text,
	"repo_full_name" text,
	"clone_url" text,
	"schedule" text NOT NULL DEFAULT 'nightly' CHECK (schedule IN ('nightly','off')),
	"enabled" boolean NOT NULL DEFAULT TRUE,
	"last_bound_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "image_sources_org_repo" ON "image_sources" ("org_id","repo_host","repo_full_name") WHERE kind = 'repo';
--> statement-breakpoint
CREATE UNIQUE INDEX "image_sources_org_base_profile" ON "image_sources" ("org_id","profile") WHERE kind = 'base';
--> statement-breakpoint
CREATE TABLE "bakes" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL REFERENCES image_sources(id) ON DELETE CASCADE,
	"identity_hash" text NOT NULL,
	"commit_sha" text,
	"image_ref" text NOT NULL,
	"status" text NOT NULL CHECK (status IN ('queued','building','pushed','failed')),
	"builder_backend" text,
	"recipe" jsonb,
	"error" text,
	"log_tail" text,
	"started_at" bigint,
	"finished_at" bigint,
	"size_bytes" BIGINT,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "bakes_source_status_created" ON "bakes" ("source_id","status","created_at");
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"service" text NOT NULL,
	"event_key" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"actor" jsonb,
	"refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" bigint NOT NULL,
	"received_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "events_service_dedupe" ON "events" ("service","dedupe_key");
--> statement-breakpoint
CREATE INDEX "events_org_received" ON "events" ("org_id","received_at");
--> statement-breakpoint
CREATE INDEX "events_org_key" ON "events" ("org_id","event_key");
--> statement-breakpoint
CREATE TABLE "event_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"event_keys" jsonb NOT NULL,
	"filters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"target" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "event_subscriptions_org_enabled" ON "event_subscriptions" ("org_id","enabled");
--> statement-breakpoint
CREATE TABLE "workflow_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"owner_type" text DEFAULT 'user' NOT NULL,
	"owner_id" text NOT NULL,
	"target_kind" text DEFAULT 'workflow' NOT NULL,
	"workflow_id" text,
	"prompt" text,
	"name" text NOT NULL,
	"cron" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"input" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_fired_at" bigint,
	"next_fire_at" bigint NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "workflow_schedules_due" ON "workflow_schedules" ("enabled","next_fire_at");
--> statement-breakpoint
CREATE INDEX "workflow_schedules_workflow" ON "workflow_schedules" ("workflow_id");
--> statement-breakpoint
CREATE TABLE "workflow_webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"org_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_webhooks_workflow" ON "workflow_webhooks" ("workflow_id");
--> statement-breakpoint
CREATE TABLE "event_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" bigint NOT NULL,
	"last_error" text,
	"delivered_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "event_deliveries_due" ON "event_deliveries" ("status","next_attempt_at");
--> statement-breakpoint
CREATE INDEX "event_deliveries_event" ON "event_deliveries" ("event_id");
--> statement-breakpoint
CREATE TABLE "linear_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"workspace_name" text NOT NULL,
	"webhook_id" text,
	"connected_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "linear_installations_org_workspace" ON "linear_installations" ("org_id","workspace_id");
--> statement-breakpoint
CREATE TABLE "llm_proxy_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" bigint NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"api_key_id" text NOT NULL,
	"provider_kind" text NOT NULL,
	"model" text,
	"harness" text,
	"endpoint" text NOT NULL,
	"provider_response_id" text,
	"previous_response_id" text,
	"stream" boolean NOT NULL,
	"status_code" integer NOT NULL,
	"request_body" text NOT NULL,
	"response_body" text,
	"input_tokens" bigint NOT NULL DEFAULT 0,
	"output_tokens" bigint NOT NULL DEFAULT 0,
	"cache_read_tokens" bigint NOT NULL DEFAULT 0,
	"cache_write_tokens" bigint NOT NULL DEFAULT 0,
	"total_tokens" bigint NOT NULL DEFAULT 0,
	"cost_usd" double precision,
	"latency_ms" integer,
	"error" text,
	"parsed" jsonb,
	"parse_version" integer,
	"parse_error" text
);
--> statement-breakpoint
CREATE INDEX "llm_proxy_requests_org_created" ON "llm_proxy_requests" ("org_id", "created_at");
--> statement-breakpoint
CREATE INDEX "llm_proxy_requests_user_created" ON "llm_proxy_requests" ("user_id", "created_at");
--> statement-breakpoint
-- ── Valet Security (docs/specs/2026-08-27-valet-security-design.md) ───────
--
-- One security engagement per kind='security' session. Cells dispatch
-- persona child sessions; the engagement tree (security_files) is the
-- personas' shared virtual filesystem, append-only by (path, revision).
CREATE TABLE "security_engagements" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"status" text DEFAULT 'planning' NOT NULL,
	"repo_full_name" text NOT NULL,
	"repo_ref" text DEFAULT '' NOT NULL,
	"plan" text DEFAULT '' NOT NULL,
	"parent_engagement_id" text,
	"base_ref" text,
	"changed_paths" text,
	"focus" text,
	"invariants" text,
	"categories" text,
	"config_personas" text,
	"config_persona_markdown" text,
	"config_tools" text,
	"has_repo_config" boolean DEFAULT false NOT NULL,
	"report_markdown" text,
	"report_json" text,
	"report_generated_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "security_engagements_session_unique" ON "security_engagements" ("session_id");
--> statement-breakpoint
CREATE INDEX "security_engagements_parent" ON "security_engagements" ("parent_engagement_id");
--> statement-breakpoint
CREATE TABLE "security_cells" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"persona" text NOT NULL,
	"mode" text DEFAULT 'fresh' NOT NULL,
	"goal" text NOT NULL,
	"dir" text NOT NULL,
	"reads" text DEFAULT '[]' NOT NULL,
	"review" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"compacted_at" bigint,
	"child_session_id" text,
	"dispatched_at" bigint,
	"settled_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "security_cells_engagement_ordinal_unique" ON "security_cells" ("engagement_id", "ordinal");
--> statement-breakpoint
CREATE INDEX "security_cells_child_session" ON "security_cells" ("child_session_id");
--> statement-breakpoint
CREATE TABLE "security_files" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"cell_id" text NOT NULL,
	"path" text NOT NULL,
	"revision" integer NOT NULL,
	"content" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "security_files_path_revision_unique" ON "security_files" ("engagement_id", "path", "revision");
--> statement-breakpoint
CREATE TABLE "security_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"cell_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"file" text,
	"line" integer,
	"body" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"status_reason" text,
	"status_actor" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "security_findings_engagement" ON "security_findings" ("engagement_id");
--> statement-breakpoint
CREATE TABLE "security_finding_links" (
	"id" text PRIMARY KEY NOT NULL,
	"finding_id" text NOT NULL,
	"engagement_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "security_finding_links_provider_unique" ON "security_finding_links" ("finding_id", "provider");
--> statement-breakpoint
-- One row per sec_handoff spawn: the fix session opened from a finding.
-- No unique constraint — a finding may spawn several fix sessions.
CREATE TABLE "security_handoffs" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"finding_id" text NOT NULL,
	"child_session_id" text NOT NULL,
	"title" text NOT NULL,
	"task" text,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "security_handoffs_engagement" ON "security_handoffs" ("engagement_id");
--> statement-breakpoint
CREATE INDEX "security_handoffs_finding" ON "security_handoffs" ("finding_id");
--> statement-breakpoint
-- One row per human note on a finding (spec §Re-scan / iterate). No unique
-- constraint — a finding may carry a thread of many comments. author_user_id
-- is always a user id: commenting is a human action, never the runner's.
CREATE TABLE "security_finding_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"finding_id" text NOT NULL,
	"engagement_id" text NOT NULL,
	"body" text NOT NULL,
	"author_user_id" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "security_finding_comments_finding" ON "security_finding_comments" ("finding_id");
--> statement-breakpoint
CREATE INDEX "security_finding_comments_engagement" ON "security_finding_comments" ("engagement_id");
--> statement-breakpoint
-- One row per coverage claim a persona records (NOT_ASSESSED ledger, M-P2d).
-- status is 'assessed' or 'not_assessed'; a not_assessed row carries a reason
-- naming the consequence. No unique constraint — a cell records one row per
-- area. The close manifest rolls these into a coverage summary + gap list.
CREATE TABLE "security_coverage" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"cell_id" text NOT NULL,
	"area" text NOT NULL,
	"status" text NOT NULL,
	"tool" text,
	"reason" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "security_coverage_engagement" ON "security_coverage" ("engagement_id");
--> statement-breakpoint
CREATE INDEX "security_coverage_cell" ON "security_coverage" ("cell_id");
--> statement-breakpoint
-- One row per need a persona records (pivot-coordinator + needs loop, M-P4c).
-- kind classes what is blocked; status tracks it through the loop
-- (open -> auto_resolved | needs_human -> answered | dismissed); resolution
-- records the auto-resolution note or the human answer. No unique constraint —
-- a cell may record several needs. The coordinator auto-resolves only
-- already-authorized items; the rest surface to the human, then re-run.
CREATE TABLE "security_needs" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"cell_id" text NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"created_at" bigint NOT NULL,
	"resolved_at" bigint
);
--> statement-breakpoint
CREATE INDEX "security_needs_engagement" ON "security_needs" ("engagement_id");
--> statement-breakpoint
CREATE INDEX "security_needs_cell" ON "security_needs" ("cell_id");
--> statement-breakpoint
-- ── cost_entries ──────────────────────────────────────────────────────────
--
-- One row per billable assistant turn, with the owner resolved. This is the
-- ONLY definition of cost attribution: Grafana queries this view directly
-- and `/api/usage/summary` aggregates the same columns, so the dashboard and
-- the in-app card cannot disagree.
--
-- It reads `engine_entries` (engine schema), so `applyAppMigrations` applies
-- the engine schema first — see `packages/api/src/lib/drizzle.ts`.
--
-- Owner resolution covers the two session kinds that produce turns:
--
--   1. Interactive, orchestrator, and child sessions have an `agent_sessions`
--      row that carries `org_id` + `user_id` directly.
--   2. Workflow sessions have NO `agent_sessions` row (they belong to
--      `workflow_runs`, not the sessions UI). Their id is
--      `wf:{runId}:{nodeId}`, or `wf:{runId}:{nodeId}:{iteration}` inside a
--      foreach body, so position 2 holds the run id in both shapes.
--      `workflow_runs` has no `org_id` column, so the org comes from the
--      parent `workflow_definitions` row.
--
-- An entry that resolves to no org is EXCLUDED. A row with an unknown org
-- could not be scoped to a tenant, and `wf:invoke:{invocationId}` (the
-- action-invocation context id) matches no run.
--
-- `user_id` is the individual to bill. A team-owned or org-owned workflow run
-- has no acting user, so `user_id` is NULL there and `owner_type`/`owner_id`
-- carry the principal instead. Such rows count toward org totals and are
-- absent from per-user totals.
--
-- `cost_total` NULL means UNPRICED, never free: the engine omits cost for
-- custom/OpenRouter providers and dev fakes rather than writing 0. Read
-- `priced` before you read `cost_total` as a complete number.
CREATE VIEW "cost_entries" AS
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
	((e."cost"::jsonb->>'total') IS NOT NULL)                  AS "priced",
	-- Valet use case, derived from the session id shape so the one cost
	-- definition can be broken down by activity kind (usage dashboard).
	CASE
		WHEN e."session_id" LIKE 'orchestrator:%' THEN 'orchestrator'
		WHEN e."session_id" LIKE 'wf:%'           THEN 'workflow'
		ELSE 'session'
	END                                                        AS "use_case"
FROM "engine_entries" e
LEFT JOIN "agent_sessions" s
	ON s."id" = e."session_id"
LEFT JOIN "workflow_runs" r
	ON e."session_id" LIKE 'wf:%'
	AND r."id" = split_part(e."session_id", ':', 2)
LEFT JOIN "workflow_definitions" d
	ON d."id" = r."workflow_id"
WHERE e."usage" IS NOT NULL
	AND COALESCE(s."org_id", d."org_id") IS NOT NULL
UNION ALL
SELECT
	p."id" AS "entry_id", NULL AS "session_id", p."created_at" AS "created_at", p."model" AS "model",
	p."org_id" AS "org_id", p."user_id" AS "user_id", 'user' AS "owner_type", p."user_id" AS "owner_id",
	NULL AS "workflow_id", NULL AS "workflow_run_id",
	p."input_tokens", p."output_tokens", p."cache_read_tokens", p."cache_write_tokens", p."total_tokens",
	p."cost_usd" AS "cost_total", (p."cost_usd" IS NOT NULL) AS "priced", 'proxy' AS "use_case"
FROM "llm_proxy_requests" p
-- Only rows that carry usage count as billable turns — mirrors the engine
-- side's `WHERE e."usage" IS NOT NULL`. Excludes failed/4xx proxy calls and
-- non-completion passthroughs (0 tokens), which would otherwise inflate
-- `/api/usage` turn counts.
WHERE p."total_tokens" > 0;
