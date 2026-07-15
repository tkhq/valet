import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { runConcurrencyContract } from "@valet/engine/test-helpers";
import { SqliteEventStream } from "../src/event-stream.js";
import { SqliteSessionStore } from "../src/index.js";
import { applyEngineMigrations } from "../src/migrate.js";

// better-sqlite3 is a synchronous driver: every call made through
// `Promise.all` in the shared contract still executes to completion one at
// a time on the JS event loop before the next begins — there is no real
// interleaving to defeat. The suite still runs here (not skipped): it
// proves the seq/fencing logic is sequentially correct and gives a fast,
// Docker-free smoke test on every `pnpm test`, but — per
// `ConcurrencyContractContext.supportsConcurrency`'s doc — it does not (and
// structurally cannot) prove genuine concurrent-access safety the way the
// docker-pg run of the same suite in `packages/store-postgres` does.
function factory(): { store: SqliteSessionStore; stream: SqliteEventStream } {
  const sqlite = new Database(":memory:");
  applyEngineMigrations(sqlite);
  const db = drizzle(sqlite);
  return { store: new SqliteSessionStore(db), stream: new SqliteEventStream(sqlite) };
}

runConcurrencyContract("SqliteSessionStore+SqliteEventStream", { factory });
