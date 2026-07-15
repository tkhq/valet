import { describe, expect, it, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import type { AppDb } from "../lib/drizzle.js";
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
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
  });

  it("create -> findValidInviteByCode round-trips", async () => {
    const { invite, code } = await createInvite(db, { role: "member", createdBy: "admin1" });
    expect(code).toMatch(/^[0-9a-f]{32}$/);

    const found = await findValidInviteByCode(db, code);
    expect(found).toEqual(invite);
  });

  it("never stores the plaintext code — code_hash is the sha256 hex of it", async () => {
    const { invite, code } = await createInvite(db, { role: "member", createdBy: "admin1" });
    const rows = await db.select().from(invites).where(eq(invites.id, invite.id)).limit(1);
    const row = rows[0];
    expect(row?.codeHash).not.toBe(code);
    expect(row?.codeHash).toBe(createHash("sha256").update(code).digest("hex"));
  });

  it("an expired invite is not found", async () => {
    const { code } = await createInvite(db, { role: "member", createdBy: "admin1", ttlMs: -1 });
    expect(await findValidInviteByCode(db, code)).toBeNull();
  });

  it("an accepted invite is not found", async () => {
    const { invite, code } = await createInvite(db, { role: "member", createdBy: "admin1" });
    await acceptInvite(db, invite.id, "new-user");
    expect(await findValidInviteByCode(db, code)).toBeNull();
  });

  it("findValidInviteByEmail matches case-insensitively", async () => {
    const { invite } = await createInvite(db, { email: "Foo@Example.com", role: "member", createdBy: "admin1" });
    const found = await findValidInviteByEmail(db, "foo@example.com");
    expect(found).toEqual(invite);
  });

  it("findValidInviteByEmail returns null with no match", async () => {
    await createInvite(db, { email: "foo@example.com", role: "member", createdBy: "admin1" });
    expect(await findValidInviteByEmail(db, "bar@example.com")).toBeNull();
  });

  it("accept is single-use — a second find (by code or email) returns null", async () => {
    const { invite, code } = await createInvite(db, {
      email: "foo@example.com",
      role: "member",
      createdBy: "admin1",
    });
    await acceptInvite(db, invite.id, "new-user");
    expect(await findValidInviteByCode(db, code)).toBeNull();
    expect(await findValidInviteByEmail(db, "foo@example.com")).toBeNull();

    const rows = await db.select().from(invites).where(eq(invites.id, invite.id)).limit(1);
    const row = rows[0];
    expect(row?.acceptedBy).toBe("new-user");
    expect(row?.acceptedAt).toBeInstanceOf(Date);
  });

  it("revoke deletes the row and returns true; false if absent", async () => {
    const { invite } = await createInvite(db, { role: "member", createdBy: "admin1" });
    expect(await revokeInvite(db, invite.id)).toBe(true);
    expect((await db.select().from(invites).where(eq(invites.id, invite.id)).limit(1))[0]).toBeUndefined();
    expect(await revokeInvite(db, invite.id)).toBe(false);
    expect(await revokeInvite(db, "nonexistent")).toBe(false);
  });

  it("listPendingInvites returns unaccepted invites, excludes accepted ones", async () => {
    const { invite: pending } = await createInvite(db, { role: "member", createdBy: "admin1" });
    const { invite: accepted } = await createInvite(db, { role: "admin", createdBy: "admin1" });
    await acceptInvite(db, accepted.id, "new-user");

    const list = await listPendingInvites(db);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(pending);
  });

  it("defaults ttl to 7 days", async () => {
    const before = Date.now();
    const { invite } = await createInvite(db, { role: "member", createdBy: "admin1" });
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(invite.expiresAt).toBeGreaterThanOrEqual(before + sevenDaysMs);
    expect(invite.expiresAt).toBeLessThanOrEqual(Date.now() + sevenDaysMs + 5_000);
  });
});
