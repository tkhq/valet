-- Webhook delivery telemetry: one row per inbound delivery across the
-- unauthenticated webhook surfaces (github, slack, channel webhooks, generic
-- workflow triggers). Recording is fire-and-forget at the route layer so a
-- telemetry failure can never break a webhook ACK. Rows older than 30 days
-- are deleted by the nightly retention sweep.
--
-- Outcomes:
--   received          — delivery accepted at the boundary (signature ok or no
--                       signature scheme), not necessarily acted on
--   invalid_signature — signature verification failed
--   processed         — delivery matched a handler that acted on it
--   failed            — a handler threw while acting on the delivery
CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_type TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('received', 'invalid_signature', 'processed', 'failed')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_webhook_deliveries_provider_created ON webhook_deliveries(provider, created_at);
-- Retention sweep scans by created_at alone.
CREATE INDEX idx_webhook_deliveries_created ON webhook_deliveries(created_at);
