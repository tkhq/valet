CREATE TABLE `agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`workspace` text NOT NULL,
	`title` text,
	`status` text DEFAULT 'active' NOT NULL,
	`owner_type` text DEFAULT 'user' NOT NULL,
	`owner_id` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_sessions_user` ON `agent_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `agent_sessions_status` ON `agent_sessions` (`status`);--> statement-breakpoint
CREATE TABLE `channel_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`channel_type` text NOT NULL,
	`conversation_key` text NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`session_id` text NOT NULL,
	`thread_key_template` text NOT NULL,
	`queue_mode` text NOT NULL,
	`trigger_mode` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_bindings_conversation` ON `channel_bindings` (`org_id`,`channel_type`,`conversation_key`);--> statement-breakpoint
CREATE TABLE `child_watches` (
	`child_session_id` text PRIMARY KEY NOT NULL,
	`queue_item_id` text NOT NULL,
	`parent_session_id` text NOT NULL,
	`parent_thread_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`settled` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `child_watches_parent` ON `child_watches` (`parent_session_id`);--> statement-breakpoint
CREATE INDEX `child_watches_settled` ON `child_watches` (`settled`);--> statement-breakpoint
CREATE TABLE `event_drop_log` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`reason` text NOT NULL,
	`conversation_key` text,
	`detail` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `event_drop_log_org` ON `event_drop_log` (`org_id`);--> statement-breakpoint
CREATE TABLE `memory_files` (
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`path` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`content` text NOT NULL,
	`type` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`resource` text DEFAULT '' NOT NULL,
	`extras` text DEFAULT '{}' NOT NULL,
	`sensitivity` text DEFAULT 'private' NOT NULL,
	`origin` text DEFAULT '' NOT NULL,
	`expires` integer,
	`pinned` integer DEFAULT 0 NOT NULL,
	`actor_user_id` text DEFAULT '' NOT NULL,
	`source_session_id` text DEFAULT '' NOT NULL,
	`org_id` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`owner_type`, `owner_id`, `path`)
);
--> statement-breakpoint
-- Virtual FTS5 table companion to `memory_files` (decision 13). Drizzle can't
-- model virtual tables, so this is raw SQL with no matching entry in
-- `schema/index.ts`; the Task 5 FTS sync helper reads/writes it directly via
-- the raw sqlite handle. BM25 weights (path 5, title 10, description 8,
-- tags 6, content 1) are applied at query time, not stored here.
CREATE VIRTUAL TABLE `memory_files_fts` USING fts5(`path`, `title`, `description`, `tags`, `content`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`urgency` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`href` text,
	`session_id` text,
	`created_at` integer NOT NULL,
	`read_at` integer
);
--> statement-breakpoint
CREATE INDEX `notifications_user_read` ON `notifications` (`user_id`,`read_at`);--> statement-breakpoint
CREATE TABLE `orchestrator_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`session_id` text NOT NULL,
	`handle` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orchestrator_identities_owner` ON `orchestrator_identities` (`org_id`,`owner_type`,`owner_id`);--> statement-breakpoint
CREATE TABLE `team_members` (
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`team_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `team_members_user` ON `team_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_org_name` ON `teams` (`org_id`,`name`);--> statement-breakpoint
CREATE TABLE `user_identity_links` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_identity_links_provider_external` ON `user_identity_links` (`provider`,`external_id`);--> statement-breakpoint
CREATE TABLE `user_notification_preferences` (
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`web` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`user_id`, `kind`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`thread_id` text,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`parts` text,
	`author_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `messages_session` ON `messages` (`session_id`);--> statement-breakpoint
CREATE INDEX `messages_thread` ON `messages` (`thread_id`);--> statement-breakpoint
CREATE INDEX `messages_created` ON `messages` (`created_at`);--> statement-breakpoint
CREATE TABLE `org_members` (
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer,
	PRIMARY KEY(`org_id`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE `orgs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`features` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`title` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `session_threads_session` ON `session_threads` (`session_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`default_model` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `sso_provider` (
	`id` text PRIMARY KEY NOT NULL,
	`issuer` text NOT NULL,
	`oidc_config` text,
	`saml_config` text,
	`user_id` text,
	`provider_id` text NOT NULL,
	`organization_id` text,
	`domain` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sso_provider_providerId_unique` ON `sso_provider` (`provider_id`);--> statement-breakpoint
CREATE TABLE `apikey` (
	`id` text PRIMARY KEY NOT NULL,
	`config_id` text DEFAULT 'default' NOT NULL,
	`name` text,
	`start` text,
	`reference_id` text NOT NULL,
	`prefix` text,
	`key` text NOT NULL,
	`refill_interval` integer,
	`refill_amount` integer,
	`last_refill_at` integer,
	`enabled` integer DEFAULT true,
	`rate_limit_enabled` integer DEFAULT true,
	`rate_limit_time_window` integer DEFAULT 86400000,
	`rate_limit_max` integer DEFAULT 10,
	`request_count` integer DEFAULT 0,
	`remaining` integer,
	`last_request` integer,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`permissions` text,
	`metadata` text
);
--> statement-breakpoint
CREATE INDEX `apikey_configId_idx` ON `apikey` (`config_id`);--> statement-breakpoint
CREATE INDEX `apikey_referenceId_idx` ON `apikey` (`reference_id`);--> statement-breakpoint
CREATE INDEX `apikey_key_idx` ON `apikey` (`key`);--> statement-breakpoint
CREATE TABLE `oauth_application` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`icon` text,
	`metadata` text,
	`client_id` text,
	`client_secret` text,
	`redirect_urls` text,
	`type` text,
	`disabled` integer DEFAULT false,
	`user_id` text,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_application_clientId_unique` ON `oauth_application` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauthApplication_userId_idx` ON `oauth_application` (`user_id`);--> statement-breakpoint
CREATE TABLE `oauth_access_token` (
	`id` text PRIMARY KEY NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`client_id` text,
	`user_id` text,
	`scopes` text,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_application`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_access_token_accessToken_unique` ON `oauth_access_token` (`access_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_access_token_refreshToken_unique` ON `oauth_access_token` (`refresh_token`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_clientId_idx` ON `oauth_access_token` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_userId_idx` ON `oauth_access_token` (`user_id`);--> statement-breakpoint
CREATE TABLE `oauth_consent` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text,
	`user_id` text,
	`scopes` text,
	`created_at` integer,
	`updated_at` integer,
	`consent_given` integer,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_application`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauthConsent_clientId_idx` ON `oauth_consent` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauthConsent_userId_idx` ON `oauth_consent` (`user_id`);--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`email` text,
	`role` text DEFAULT 'member' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_by` text,
	`accepted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_code_hash_unique` ON `invites` (`code_hash`);--> statement-breakpoint
CREATE INDEX `idx_invites_email` ON `invites` (`email`);--> statement-breakpoint
CREATE TABLE `sandbox_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sandbox_tokens_token_hash_unique` ON `sandbox_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_sandbox_tokens_hash` ON `sandbox_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `workflow_checkpoints` (
	`run_id` text NOT NULL,
	`node_id` text NOT NULL,
	`iteration` integer DEFAULT 0 NOT NULL,
	`attempt` integer NOT NULL,
	`status` text NOT NULL,
	`result` text,
	`effects` text,
	`error` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `node_id`, `iteration`)
);
--> statement-breakpoint
CREATE INDEX `workflow_checkpoints_run` ON `workflow_checkpoints` (`run_id`);--> statement-breakpoint
CREATE TABLE `workflow_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`definition` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workflow_definitions_owner` ON `workflow_definitions` (`org_id`,`owner_type`,`owner_id`);--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`definition_version_id` text NOT NULL,
	`definition` text NOT NULL,
	`params` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`outcome` text,
	`waiting_on` text DEFAULT '[]' NOT NULL,
	`wake_at` integer,
	`wake_requested` integer DEFAULT 0 NOT NULL,
	`lease_owner_id` text,
	`lease_expires_at` integer,
	`attempt` integer DEFAULT 0 NOT NULL,
	`owner_type` text DEFAULT 'user' NOT NULL,
	`owner_id` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workflow_runs_status_updated` ON `workflow_runs` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `workflow_runs_workflow` ON `workflow_runs` (`workflow_id`);--> statement-breakpoint
CREATE TABLE `workflow_signals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`signal_id` text NOT NULL,
	`signal_type` text NOT NULL,
	`payload` text,
	`created_at` integer NOT NULL,
	`consumed_at` integer,
	`consumed_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_signals_run_signal` ON `workflow_signals` (`run_id`,`signal_id`);--> statement-breakpoint
CREATE INDEX `workflow_signals_run` ON `workflow_signals` (`run_id`);--> statement-breakpoint
CREATE TABLE `credentials` (
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`service` text NOT NULL,
	`type` text NOT NULL,
	`access_token_enc` text,
	`refresh_token_enc` text,
	`api_key_enc` text,
	`expires_at` integer,
	`scopes` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`owner_type`, `owner_id`, `service`)
);
--> statement-breakpoint
CREATE TABLE `action_invocations` (
	`invocation_id` text PRIMARY KEY NOT NULL,
	`result` text NOT NULL,
	`created_at` integer NOT NULL
);