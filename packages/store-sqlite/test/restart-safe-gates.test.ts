import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { runRestartSafeGatesContract } from "@valet/engine/test-helpers";
import { SqliteSessionStore } from "../src/index.js";
import { applyEngineMigrations } from "../src/migrate.js";

runRestartSafeGatesContract("SqliteSessionStore", () => {
  const sqlite = new Database(":memory:");
  applyEngineMigrations(sqlite);
  return new SqliteSessionStore(drizzle(sqlite));
});
