CREATE TABLE "orgs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"model_preferences" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" bigint NOT NULL
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
	"prebuild_id" text,
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
	"created_at" bigint NOT NULL
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
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "teams_org_name" ON "teams" ("org_id","name");
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
CREATE TABLE "orchestrator_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"session_id" text NOT NULL,
	"handle" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "orchestrator_identities_owner" ON "orchestrator_identities" ("org_id","owner_type","owner_id");
--> statement-breakpoint
CREATE TABLE "child_watches" (
	"child_session_id" text PRIMARY KEY NOT NULL,
	"queue_item_id" text NOT NULL,
	"parent_session_id" text NOT NULL,
	"parent_thread_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"settled" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "child_watches_parent" ON "child_watches" ("parent_session_id");
--> statement-breakpoint
CREATE INDEX "child_watches_settled" ON "child_watches" ("settled");
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
	"metadata" jsonb,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "action_invocations" (
	"invocation_id" text PRIMARY KEY NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
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
	"position" integer NOT NULL
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
CREATE TABLE "image_catalog" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"ref" text NOT NULL,
	"pull_secret_name" text,
	"kind" text DEFAULT 'base' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "image_catalog_org" ON "image_catalog" ("org_id");
--> statement-breakpoint
CREATE TABLE "prebuild_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_host" text DEFAULT 'github' NOT NULL,
	"repo_full_name" text NOT NULL,
	"clone_url" text NOT NULL,
	"base_image_id" text,
	"schedule" text DEFAULT 'nightly' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "prebuild_configs_org" ON "prebuild_configs" ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "prebuild_configs_org_repo" ON "prebuild_configs" ("org_id","repo_host","repo_full_name");
--> statement-breakpoint
CREATE TABLE "prebuilds" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"image_ref" text NOT NULL,
	"status" text NOT NULL,
	"builder_backend" text NOT NULL,
	"recipe" jsonb NOT NULL,
	"error" text,
	"log_tail" text,
	"started_at" bigint,
	"finished_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "prebuilds_config_status_created" ON "prebuilds" ("config_id","status","created_at");
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
