# Lazy session history implementation plan

**Goal:** Restore idle sessions without reading thread history.

**Architecture:** Restore thread metadata immediately. Load each restored transcript before its first run, blocked-tool replay, or compaction. Keep reconciliation and REST pagination intact.

**Tech stack:** TypeScript, Vitest, Hono, PostgreSQL.

1. Add engine regression tests for zero history reads during idle restore and correct context on the first prompt.
2. Defer restored transcript loading in `Session` and `Thread`. Retry failed loads and share concurrent loads.
3. Add API coverage for cold `/threads` and `/commands` requests with persisted history.
4. Update the engine specification. Run engine, store, API integration, and `make e2e` checks.
5. Review the diff, commit the fix, and open a PR against `dev-v2`.

Active threads still load their full persisted history. Byte budgets and history retention are separate changes.
