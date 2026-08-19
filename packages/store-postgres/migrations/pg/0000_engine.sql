CREATE TABLE "engine_decision_gate_refs" (
	"id" text PRIMARY KEY NOT NULL,
	"gate_id" text NOT NULL,
	"channel_type" text NOT NULL,
	"ref" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "engine_decision_gate_refs_gate" ON "engine_decision_gate_refs" ("gate_id");
--> statement-breakpoint
CREATE TABLE "engine_decision_gates" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"queue_item_id" text NOT NULL,
	"resume_key" text NOT NULL,
	"ordinal" integer NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"actions" text NOT NULL,
	"origin" text,
	"context" text,
	"resolution" text,
	"expires_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "engine_decision_gates_thread" ON "engine_decision_gates" ("session_id","thread_id","status");
--> statement-breakpoint
CREATE INDEX "engine_decision_gates_resume" ON "engine_decision_gates" ("session_id","thread_id","queue_item_id","resume_key");
--> statement-breakpoint
CREATE TABLE "engine_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"parent_id" text,
	"entry_type" text NOT NULL,
	"role" text,
	"content" text,
	"parts" text,
	"signal" text,
	"author" text,
	"channel" text,
	"model" text,
	"queue_item_id" text,
	"stop_reason" text,
	"summary" text,
	"covered_entry_ids" text,
	"token_count_before" integer,
	"token_count_after" integer,
	"file_context" text,
	"branch_root_id" text,
	"branch_leaf_id" text,
	"gate_id" text,
	"resolved_at" text,
	"resolution" text,
	"withdrawn_reason" text,
	"metadata" text,
	"usage" text,
	"cost" text,
	"attachments" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "engine_entries_thread" ON "engine_entries" ("session_id","thread_id","created_at");
--> statement-breakpoint
CREATE INDEX "engine_entries_gate" ON "engine_entries" ("gate_id");
--> statement-breakpoint
CREATE INDEX "engine_entries_queue_item" ON "engine_entries" ("queue_item_id");
--> statement-breakpoint
-- Cost attribution reads entries by time window across ALL sessions. The
-- three indexes above cannot serve that predicate: two lead with a column
-- the window query does not constrain, and the third leads with session_id.
-- The partial predicate keeps the index to the small minority of entries
-- that carry usage (one per assistant turn, never a user/tool entry).
CREATE INDEX "engine_entries_usage_window" ON "engine_entries" ("created_at") WHERE "usage" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "engine_queue_items" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"dispatch_id" text,
	"status" text NOT NULL,
	"outcome" text,
	"error" text,
	"superseded_by_item_id" text,
	"merged_into_item_id" text,
	"content" text NOT NULL,
	"author" text,
	"channel" text,
	"reply_target" text,
	"model" text,
	"role" text,
	"metadata" text,
	"attempt_id" text,
	"attempt_count" integer NOT NULL,
	"max_attempts" integer NOT NULL,
	"credential_attempts" integer NOT NULL DEFAULT 0,
	"last_credential_release_at" bigint,
	"timeout_at" bigint NOT NULL,
	"abort_requested_at" bigint,
	"owner_id" text,
	"lease_expires_at" bigint,
	"settle_patch_status" text,
	"settle_patch_reason" text,
	"settle_patch_blob_key" text,
	"settle_patch_bytes" integer,
	"settle_patch_truncated" integer,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "engine_queue_items_thread" ON "engine_queue_items" ("session_id","thread_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "engine_queue_items_dispatch" ON "engine_queue_items" ("session_id","dispatch_id") WHERE "dispatch_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "engine_attempt_markers" (
	"item_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	PRIMARY KEY("item_id", "attempt_id")
);
--> statement-breakpoint
CREATE TABLE "engine_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
INSERT INTO "engine_meta" ("key", "value") VALUES ('schema_version', '3');
--> statement-breakpoint
CREATE TABLE "engine_events" (
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"event_key" text NOT NULL,
	"thread_id" text,
	"queue_item_id" text,
	"user_id" text,
	"event_type" text NOT NULL,
	"payload" text NOT NULL,
	"timestamp" bigint NOT NULL,
	PRIMARY KEY ("session_id", "seq")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "engine_events_event_key" ON "engine_events" ("session_id","event_key");
--> statement-breakpoint
CREATE INDEX "engine_events_queue_item" ON "engine_events" ("session_id","queue_item_id");
--> statement-breakpoint
CREATE TABLE "engine_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"workspace" text NOT NULL,
	"purpose" text NOT NULL,
	"status" text NOT NULL,
	"sandbox_id" text,
	"snapshot_id" text,
	"parent_session_id" text,
	"parent_thread_id" text,
	"model" text,
	"metadata" text,
	"start_ref" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "engine_sessions_user" ON "engine_sessions" ("user_id");
--> statement-breakpoint
CREATE INDEX "engine_sessions_status" ON "engine_sessions" ("status");
--> statement-breakpoint
CREATE INDEX "engine_sessions_owner" ON "engine_sessions" ("owner_type","owner_id");
--> statement-breakpoint
CREATE TABLE "engine_suspended_turns" (
	"session_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"queue_item_id" text NOT NULL,
	"gate_id" text NOT NULL,
	"model" text NOT NULL,
	"leaf_entry_id" text,
	"tool_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"tool_args" text NOT NULL,
	"resume_key" text NOT NULL,
	"ordinal" integer NOT NULL,
	"attempt" integer NOT NULL,
	"created_at" bigint NOT NULL,
	PRIMARY KEY("session_id", "thread_id")
);
--> statement-breakpoint
CREATE INDEX "engine_suspended_turns_gate" ON "engine_suspended_turns" ("gate_id");
--> statement-breakpoint
CREATE TABLE "engine_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"key" text NOT NULL,
	"status" text NOT NULL,
	"active_leaf_entry_id" text,
	"queue_mode" text NOT NULL,
	"paused" integer,
	"model" text,
	"summary" text,
	"metadata" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "engine_threads_session" ON "engine_threads" ("session_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "engine_threads_session_key" ON "engine_threads" ("session_id","key");
