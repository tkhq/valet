import { describe, expect, it, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import type { AppDb } from "../lib/drizzle.js";
import { invites, users } from "../schema/index.js";
import { createInvite } from "./invites.js";
import { evaluateAdmission } from "./provisioning.js";
import type { AuthConfig } from "./config.js";
import { BOOTSTRAP_INVITE_CREATOR, ensureBootstrapAdminInvite } from "./bootstrap-admin.js";

function codeOf(link: string | null): string {
  const code = link ? new URL(link, "http://valet.test").searchParams.get("invite") : null;
  if (!code) throw new Error("expected a sign-up link with an invite code");
  return code;
}

const cfg: AuthConfig = {
  secret: "test-secret", baseUrl: "http://localhost:8788", trustedOrigins: [], allowedEmailDomains: [],
  social: {}, sandboxJwtMaster: "test-secret",
};

describe("ensureBootstrapAdminInvite", () => {
  let db: AppDb;
  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
  });

  it("prints a one-time admin sign-up link when there are no users", async () => {
    const lines: string[] = [];
    const link = await ensureBootstrapAdminInvite(db, { publicUrl: "https://valet.example.test/", log: (line) => lines.push(line) });
    expect(link).toMatch(/^https:\/\/valet\.example\.test\/signup\?invite=[0-9a-f]{32}$/);
    expect(lines.join("\n")).toContain(link!);
    expect(await evaluateAdmission(db, cfg, "operator@anywhere.test", codeOf(link)))
      .toMatchObject({ allowed: true, role: "admin" });
  });

  it("replaces the previous link on every boot, so only the newest code admits", async () => {
    const first = codeOf(await ensureBootstrapAdminInvite(db, { log: () => {} }));
    const second = codeOf(await ensureBootstrapAdminInvite(db, { log: () => {} }));
    expect(await evaluateAdmission(db, cfg, "a@x.test", first)).toEqual({ allowed: false });
    expect(await evaluateAdmission(db, cfg, "a@x.test", second)).toMatchObject({ role: "admin" });
  });

  it("mints nothing when the config already declares an admin", async () => {
    await createInvite(db, { email: "admin@corp.test", role: "admin", createdBy: "config" });
    expect(await ensureBootstrapAdminInvite(db, { log: () => {} })).toBeNull();
  });

  it("mints nothing once a user exists, and removes an unused bootstrap link", async () => {
    await ensureBootstrapAdminInvite(db, { log: () => {} });
    await db.insert(users).values({ id: "u1", email: "u1@x.test", name: "u1", role: "admin" });
    expect(await ensureBootstrapAdminInvite(db, { log: () => {} })).toBeNull();
    expect(await db.select().from(invites).where(eq(invites.createdBy, BOOTSTRAP_INVITE_CREATOR))).toHaveLength(0);
  });
});
