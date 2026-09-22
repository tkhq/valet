import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateEphemeralManagedEgressCa } from "./managed-egress-ca.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("ephemeral managed egress CA", () => {
  it("generates a fresh matching CA and removes private-key files", async () => {
    const root = await mkdtemp(join(tmpdir(), "valet-ca-test-"));
    roots.push(root);
    const first = await generateEphemeralManagedEgressCa(root);
    const second = await generateEphemeralManagedEgressCa(root);
    const firstCert = new X509Certificate(first.caCert);
    const secondCert = new X509Certificate(second.caCert);

    expect(firstCert.ca).toBe(true);
    expect(firstCert.checkPrivateKey(createPrivateKey(first.caKey))).toBe(true);
    expect(firstCert.fingerprint256).not.toBe(secondCert.fingerprint256);
    expect(first.caKey).not.toBe(second.caKey);
    expect(await readdir(root)).toEqual([]);
  });
});
