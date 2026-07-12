import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { SqliteSessionStore } from "../src/index.js";
import { applyEngineMigrations } from "../src/migrate.js";
import {
  runSessionStoreContract,
  runSubmissionLifecycleContract,
} from "@valet/engine/test-helpers";

function factory(): SqliteSessionStore {
  const sqlite = new Database(":memory:");
  applyEngineMigrations(sqlite);
  const db = drizzle(sqlite);
  return new SqliteSessionStore(db);
}

runSessionStoreContract("SqliteSessionStore", {
  factory,
});

runSubmissionLifecycleContract("SqliteSessionStore", {
  factory,
});
