import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../test-utils/db.js';
import { updateSessionStatus } from './sessions.js';

/**
 * Regression: updateSessionStatus used to write `errorMessage: errorMessage
 * || null`, silently clearing the stored error on EVERY status write that
 * omitted the argument. Terminating an errored session (routine cleanup)
 * therefore reclassified it as cleanly resolved in the value metrics, while
 * the same session left to the archive cron stayed errored. The fix makes
 * `undefined` preserve, `null` clear explicitly.
 */
describe('updateSessionStatus error_message semantics', () => {
  function seed() {
    const { db, sqlite } = createTestDb();
    sqlite.prepare(`INSERT INTO users (id, email) VALUES ('u1', 'u1@example.com')`).run();
    sqlite
      .prepare(
        `INSERT INTO sessions (id, user_id, workspace, status, error_message) VALUES ('s1', 'u1', 'w', 'error', 'sandbox exploded')`,
      )
      .run();
    const errorOf = () =>
      (sqlite.prepare(`SELECT error_message AS e FROM sessions WHERE id = 's1'`).get() as { e: string | null }).e;
    return { db, errorOf };
  }

  it('preserves the stored error when the argument is omitted (terminal cleanup)', async () => {
    const { db, errorOf } = seed();
    await updateSessionStatus(db, 's1', 'terminated');
    expect(errorOf()).toBe('sandbox exploded');
  });

  it('clears the error on explicit null (recovery reached a healthy state)', async () => {
    const { db, errorOf } = seed();
    await updateSessionStatus(db, 's1', 'running', undefined, null);
    expect(errorOf()).toBeNull();
  });

  it('sets a new error when a message is passed', async () => {
    const { db, errorOf } = seed();
    await updateSessionStatus(db, 's1', 'error', undefined, 'new failure');
    expect(errorOf()).toBe('new failure');
  });
});
