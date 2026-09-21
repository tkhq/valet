-- Cover org-level LLM usage scans without reading the wider events table.
-- The partial predicate keeps non-LLM analytics out of this reporting index.
CREATE INDEX IF NOT EXISTS idx_analytics_events_usage_report
  ON analytics_events(
    created_at, user_id, model, session_id, input_tokens, output_tokens,
    cache_read_tokens, cache_write_tokens, reasoning_tokens
  )
  WHERE event_type = 'llm_call';
