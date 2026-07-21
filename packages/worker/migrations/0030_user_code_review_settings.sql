-- Per-user (repo-owner) preferences for the AI code-review automation.
-- These are the USER-scoped half of the settings; the ORG-scoped half lives in
-- org_service_configs.metadata (GitHubServiceMetadata.codeReview*). Precedence is
-- org-ceiling + user-may-only-loosen, mirroring resolveEffectiveActionPolicy.
--   code_review_enabled      = 1: the owner's armed automations run (default).
--                              0: the owner opts their own repos out entirely.
--   code_review_mention_only = 1: skip the initial on-open review; only review
--                                 when someone @mentions the bot (a "loosening").
ALTER TABLE users ADD COLUMN code_review_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN code_review_mention_only INTEGER NOT NULL DEFAULT 0;
