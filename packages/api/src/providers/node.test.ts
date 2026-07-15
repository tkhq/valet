/**
 * Provider-level regression test for the auth-v2 final-review fix:
 * `buildNodeProviders({ seedLocalIdentity: false })` must not seed the
 * `local-user`/`local-org` stub identity. Without this, a real-auth
 * production boot (`BETTER_AUTH_SECRET` set, `main.ts` passes
 * `seedLocalIdentity: !authConfig`) would start with 1 pre-seeded user,
 * permanently defeating `evaluateAdmission`'s "zero users → first signup
 * becomes admin" rule (`auth/provisioning.ts`).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNodeProviders } from "./node.js";
import { users } from "../schema/index.js";

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

describe("buildNodeProviders seedLocalIdentity", () => {
  it("seeds the local-dev identity by default (backward compat)", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "valet-node-providers-test-"));
    const providers = await buildNodeProviders({
      pgDataDir: join(tmpDir, "pg"),
      blobsRoot: join(tmpDir, "blobs"),
      encryptionKey: "test-key",
      plugins: [],
    });
    const rows = await providers.db.select({ id: users.id }).from(users);
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe("local-user");
  });

  it("seeds no users when seedLocalIdentity is false", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "valet-node-providers-test-"));
    const providers = await buildNodeProviders({
      pgDataDir: join(tmpDir, "pg"),
      blobsRoot: join(tmpDir, "blobs"),
      encryptionKey: "test-key",
      plugins: [],
      seedLocalIdentity: false,
    });
    const rows = await providers.db.select({ id: users.id }).from(users);
    expect(rows.length).toBe(0);
  });
});
