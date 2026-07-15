import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { applyAppMigrations, buildAppDb, type AppDb } from "../lib/drizzle.js";
import { invites } from "../schema/index.js";
import {
  acceptInvite,
  createInvite,
  findValidInviteByCode,
  findValidInviteByEmail,
  listPendingInvites,
  revokeInvite,
} from "./invites.js";

describe("invites service", () => {
  let sqlite: Database.Database;
  let db: AppDb;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    applyAppMigrations(sqlite);
    db = buildAppDb(sqlite);
  });

  it("create -> findValidInviteByCode round-trips", () => {
    const { invite, code } = createInvite(db, { role: "member", createdBy: "admin1" });
    expect(code).toMatch(/^[0-9a-f]{32}$/);

    const found = findValidInviteByCode(db, code);
    expect(found).toEqual(invite);
  });

  it("never stores the plaintext code — code_hash is the sha256 hex of it", () => {
    const { invite, code } = createInvite(db, { role: "member", createdBy: "admin1" });
    const row = db.select().from(invites).where(eq(invites.id, invite.id)).get();
    expect(row?.codeHash).not.toBe(code);
    expect(row?.codeHash).toBe(createHash("sha256").update(code).digest("hex"));
  });

  it("an expired invite is not found", () => {
    const { code } = createInvite(db, { role: "member", createdBy: "admin1", ttlMs: -1 });
    expect(findValidInviteByCode(db, code)).toBeNull();
  });

  it("an accepted invite is not found", () => {
    const { invite, code } = createInvite(db, { role: "member", createdBy: "admin1" });
    acceptInvite(db, invite.id, "new-user");
    expect(findValidInviteByCode(db, code)).toBeNull();
  });

  it("findValidInviteByEmail matches case-insensitively", () => {
    const { invite } = createInvite(db, { email: "Foo@Example.com", role: "member", createdBy: "admin1" });
    const found = findValidInviteByEmail(db, "foo@example.com");
    expect(found).toEqual(invite);
  });

  it("findValidInviteByEmail returns null with no match", () => {
    createInvite(db, { email: "foo@example.com", role: "member", createdBy: "admin1" });
    expect(findValidInviteByEmail(db, "bar@example.com")).toBeNull();
  });

  it("accept is single-use — a second find (by code or email) returns null", () => {
    const { invite, code } = createInvite(db, {
      email: "foo@example.com",
      role: "member",
      createdBy: "admin1",
    });
    acceptInvite(db, invite.id, "new-user");
    expect(findValidInviteByCode(db, code)).toBeNull();
    expect(findValidInviteByEmail(db, "foo@example.com")).toBeNull();

    const row = db.select().from(invites).where(eq(invites.id, invite.id)).get();
    expect(row?.acceptedBy).toBe("new-user");
    expect(row?.acceptedAt).toBeInstanceOf(Date);
  });

  it("revoke deletes the row and returns true; false if absent", () => {
    const { invite } = createInvite(db, { role: "member", createdBy: "admin1" });
    expect(revokeInvite(db, invite.id)).toBe(true);
    expect(db.select().from(invites).where(eq(invites.id, invite.id)).get()).toBeUndefined();
    expect(revokeInvite(db, invite.id)).toBe(false);
    expect(revokeInvite(db, "nonexistent")).toBe(false);
  });

  it("listPendingInvites returns unaccepted invites, excludes accepted ones", () => {
    const { invite: pending } = createInvite(db, { role: "member", createdBy: "admin1" });
    const { invite: accepted } = createInvite(db, { role: "admin", createdBy: "admin1" });
    acceptInvite(db, accepted.id, "new-user");

    const list = listPendingInvites(db);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(pending);
  });

  it("defaults ttl to 7 days", () => {
    const before = Date.now();
    const { invite } = createInvite(db, { role: "member", createdBy: "admin1" });
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(invite.expiresAt).toBeGreaterThanOrEqual(before + sevenDaysMs);
    expect(invite.expiresAt).toBeLessThanOrEqual(Date.now() + sevenDaysMs + 5_000);
  });
});
