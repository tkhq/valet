import { beforeEach, describe, expect, it } from "vitest";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import {
  consumeLinkCode,
  identityForExternal,
  identityForUser,
  linkIdentity,
  mintLinkCode,
  setNotifyAttention,
  unlinkIdentity,
} from "./identity-links.js";

describe("identity link codes", () => {
  let db: TestPgDb;
  beforeEach(async () => {
    db = await freshTestPgDb();
  });

  it("mints a code and consumes it exactly once", async () => {
    const code = await mintLinkCode(db.appDb, "u1", "telegram");
    expect(code.length).toBeGreaterThanOrEqual(20);
    expect(await consumeLinkCode(db.appDb, "telegram", code)).toEqual({ userId: "u1", externalId: null });
    expect(await consumeLinkCode(db.appDb, "telegram", code)).toBeNull();
  });

  it("rejects expired codes", async () => {
    const t0 = 1_000_000;
    const code = await mintLinkCode(db.appDb, "u1", "telegram", { now: t0 });
    expect(await consumeLinkCode(db.appDb, "telegram", code, t0 + 11 * 60_000)).toBeNull();
  });

  it("rejects unknown codes", async () => {
    expect(await consumeLinkCode(db.appDb, "telegram", "nope")).toBeNull();
  });

  it("re-minting invalidates the previous code", async () => {
    const first = await mintLinkCode(db.appDb, "u1", "telegram");
    const second = await mintLinkCode(db.appDb, "u1", "telegram");
    expect(await consumeLinkCode(db.appDb, "telegram", first)).toBeNull();
    expect(await consumeLinkCode(db.appDb, "telegram", second)).toEqual({ userId: "u1", externalId: null });
  });

  it("carries the pre-chosen externalId through mint → consume (slack DM-code flow)", async () => {
    const code = await mintLinkCode(db.appDb, "u1", "slack", { externalId: "U777" });
    expect(await consumeLinkCode(db.appDb, "slack", code)).toEqual({ userId: "u1", externalId: "U777" });
  });
});

describe("identity links", () => {
  let db: TestPgDb;
  beforeEach(async () => {
    db = await freshTestPgDb();
  });

  it("links, reads both directions, unlinks", async () => {
    await linkIdentity(db.appDb, { provider: "telegram", externalId: "77", userId: "u1" });
    expect(await identityForExternal(db.appDb, "telegram", "77")).toEqual({
      userId: "u1",
      notifyAttention: true,
    });
    expect(await identityForUser(db.appDb, "telegram", "u1")).toMatchObject({ externalId: "77" });
    await unlinkIdentity(db.appDb, "telegram", "u1");
    expect(await identityForExternal(db.appDb, "telegram", "77")).toBeNull();
  });

  it("re-linking the same telegram account to a new user replaces the row", async () => {
    await linkIdentity(db.appDb, { provider: "telegram", externalId: "77", userId: "u1" });
    await linkIdentity(db.appDb, { provider: "telegram", externalId: "77", userId: "u2" });
    expect(await identityForExternal(db.appDb, "telegram", "77")).toEqual({
      userId: "u2",
      notifyAttention: true,
    });
    expect(await identityForUser(db.appDb, "telegram", "u1")).toBeNull();
  });

  it("re-linking the same user to a new telegram account replaces the row", async () => {
    await linkIdentity(db.appDb, { provider: "telegram", externalId: "77", userId: "u1" });
    await linkIdentity(db.appDb, { provider: "telegram", externalId: "88", userId: "u1" });
    expect(await identityForExternal(db.appDb, "telegram", "77")).toBeNull();
    expect(await identityForUser(db.appDb, "telegram", "u1")).toMatchObject({ externalId: "88" });
  });

  it("notification preference toggles", async () => {
    await linkIdentity(db.appDb, { provider: "telegram", externalId: "77", userId: "u1" });
    await setNotifyAttention(db.appDb, "telegram", "u1", false);
    expect((await identityForExternal(db.appDb, "telegram", "77"))?.notifyAttention).toBe(false);
  });
});
