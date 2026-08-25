import { describe, expect, it, beforeEach } from "vitest";
import { ValidationError } from "@valet/shared";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { users } from "../schema/index.js";
import { getUserModelPreferences, setUserModelPreferences } from "./user.js";

describe("user service", () => {
  let db: AppDb;
  const userId = "user1";

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    await db.insert(users).values({
      id: userId,
      email: "user1@x.test",
      name: "user1",
      role: "member",
    });
  });

  describe("getUserModelPreferences / setUserModelPreferences", () => {
    it("defaults to an empty array", async () => {
      expect(await getUserModelPreferences(db, userId)).toEqual([]);
    });

    it("round-trips a set list", async () => {
      await setUserModelPreferences(db, userId, ["anthropic/claude-opus-4", "openai/gpt-5"]);
      expect(await getUserModelPreferences(db, userId)).toEqual([
        "anthropic/claude-opus-4",
        "openai/gpt-5",
      ]);
    });

    it("clears the list when set to []", async () => {
      await setUserModelPreferences(db, userId, ["anthropic/claude-opus-4"]);
      await setUserModelPreferences(db, userId, []);
      expect(await getUserModelPreferences(db, userId)).toEqual([]);
    });

    it("reads [] for a missing user", async () => {
      expect(await getUserModelPreferences(db, "no-such-user")).toEqual([]);
    });

    it("rejects a non-array value", async () => {
      // Parsed from JSON rather than constructed, to exercise the runtime
      // guard the way a malformed request body would. Typed `unknown` so
      // `JSON.parse`'s `any` does not leak into the test.
      const bogus: unknown = JSON.parse('"not-an-array"');
      await expect(setUserModelPreferences(db, userId, bogus)).rejects.toThrow(ValidationError);
    });

    it("rejects an array that is not all strings", async () => {
      const bogus: unknown = JSON.parse('["ok", 42]');
      await expect(setUserModelPreferences(db, userId, bogus)).rejects.toThrow(ValidationError);
    });
  });
});
