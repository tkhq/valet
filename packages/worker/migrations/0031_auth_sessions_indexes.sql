-- Add indexes on auth_sessions to keep session-scoped operations O(log n).
--
-- Prior state: only (token_hash) was indexed. That was fine for the
-- per-request middleware SELECT but every operation that filters by
-- another column full-scanned the table:
--   1. The FK cascade on `users` delete (WHERE user_id = ?)
--   2. `deleteUserAuthSessions` — called by both `deleteUser` and the
--      admin `POST /users/:id/revoke-sessions` route.
--   3. The nightly `nightly_auth_session_expiry` cron sweep, which
--      does `DELETE ... WHERE id IN (SELECT id FROM auth_sessions
--      WHERE expires_at < ? LIMIT 1000)` in batches of 1000 until zero.
--
-- Without these indexes, admin revoke on a busy org and the nightly
-- sweep both degrade to O(n) per invocation and eventually TLE at
-- D1's per-statement timeout as the table grows.

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at);
