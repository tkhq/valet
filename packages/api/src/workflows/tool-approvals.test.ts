import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { credentials, githubInstallations, workflowToolApprovals } from "../schema/index.js";
import {
  findWorkflowToolApproval,
  listWorkflowToolApprovals,
  resolveWorkflowCredentialIdentity,
  workflowApprovalFingerprint,
  writeWorkflowToolApproval,
  type WorkflowApprovalIdentity,
} from "./tool-approvals.js";

const base: WorkflowApprovalIdentity = {
  orgId: "org-1",
  owner: { type: "user", id: "user-1" },
  workflowId: "wf-1",
  definitionVersionId: "version-1",
  nodeId: "post",
  service: "slack",
  actionId: "slack.send_message",
  pluginVersion: "1",
  credential: "user",
  credentialIdentity: "row:stable-credential-1",
  params: { channel: "C1", message: { text: "hello", unfurl: false } },
  policyRevision: "policy-1",
};

describe("workflowApprovalFingerprint", () => {
  it("is stable for equivalent canonical params", () => {
    const reordered: WorkflowApprovalIdentity = {
      ...base,
      params: { message: { unfurl: false, text: "hello" }, channel: "C1" },
    };
    expect(workflowApprovalFingerprint(reordered)).toBe(workflowApprovalFingerprint(base));
  });

  it.each([
    ["owner", { owner: { type: "user" as const, id: "user-2" } }],
    ["workflow", { workflowId: "wf-2" }],
    ["definition", { definitionVersionId: "version-2" }],
    ["node", { nodeId: "post-2" }],
    ["action", { actionId: "slack.delete_message" }],
    ["plugin version", { pluginVersion: "2" }],
    ["credential mode", { credential: "app" as const }],
    ["credential identity", { credentialIdentity: "row:stable-credential-2" }],
    ["params", { params: { channel: "C2", message: { text: "hello", unfurl: false } } }],
    ["policy", { policyRevision: "policy-2" }],
  ])("changes when %s changes", (_label, change) => {
    expect(workflowApprovalFingerprint({ ...base, ...change })).not.toBe(workflowApprovalFingerprint(base));
  });
});


describe("workflow approval persistence", () => {
  let db: AppDb;

  beforeAll(async () => {
    ({ appDb: db } = await freshTestPgDb());
  });

  beforeEach(async () => {
    await db.delete(workflowToolApprovals);
    await db.delete(githubInstallations);
    await db.delete(credentials);
  });

  it("uses stable credential-row identity across token rotation", async () => {
    await db.insert(credentials).values({
      ownerType: "user", ownerId: "user-1", service: "slack", type: "oauth2",
      accessTokenEnc: "ciphertext-1", refreshTokenEnc: "refresh-1",
      metadata: { accountId: "acct-1" }, createdAt: 100, updatedAt: 100,
    });
    const input = {
      db, orgId: "org-1", owner: { type: "user" as const, id: "user-1" },
      service: "slack", params: {}, orgProvided: false, credentialRequired: true, now: 1_000,
    };
    const first = await resolveWorkflowCredentialIdentity(input);
    await db.update(credentials).set({
      accessTokenEnc: "ciphertext-2", refreshTokenEnc: "refresh-2", updatedAt: 200,
    }).where(eq(credentials.service, "slack"));
    expect(await resolveWorkflowCredentialIdentity(input)).toBe(first);

    await db.delete(credentials).where(eq(credentials.service, "slack"));
    await db.insert(credentials).values({
      ownerType: "user", ownerId: "user-1", service: "slack", type: "oauth2",
      accessTokenEnc: "ciphertext-3", metadata: { accountId: "acct-1" }, createdAt: 300, updatedAt: 300,
    });
    expect(await resolveWorkflowCredentialIdentity(input)).not.toBe(first);
  });

  it("fails closed when a required credential has no stable row", async () => {
    const common = {
      db, orgId: "org-1", owner: { type: "user" as const, id: "user-1" },
      service: "linear", params: {}, orgProvided: false, now: 1_000,
    };
    expect(await resolveWorkflowCredentialIdentity({ ...common, credentialRequired: true })).toBeUndefined();
    expect(await resolveWorkflowCredentialIdentity({ ...common, credentialRequired: false })).toBe("not-required");
  });

  it("binds GitHub App reuse to the selected installation ID", async () => {
    await db.insert(githubInstallations).values([
      { id: "ghi-1", orgId: "org-1", installationId: 111, accountLogin: "acme", accountType: "Organization", createdAt: 1, updatedAt: 1 },
      { id: "ghi-2", orgId: "org-1", installationId: 222, accountLogin: "other", accountType: "Organization", createdAt: 1, updatedAt: 1 },
    ]);
    const common = {
      db, orgId: "org-1", owner: { type: "user" as const, id: "user-1" }, service: "github",
      credential: "app" as const, orgProvided: false, credentialRequired: true, now: 1_000,
    };
    expect(await resolveWorkflowCredentialIdentity({ ...common, params: { owner: "ACME", repo: "api" } }))
      .toBe("github-installation:111");
    expect(await resolveWorkflowCredentialIdentity({ ...common, params: { owner: "other", repo: "api" } }))
      .toBe("github-installation:222");
    expect(await resolveWorkflowCredentialIdentity({ ...common, params: { owner: "missing", repo: "api" } }))
      .toBeUndefined();
  });

  it("does not mistake an unusable GitHub row for the selected credential", async () => {
    await db.insert(credentials).values({
      ownerType: "user", ownerId: "user-1", service: "github", type: "oauth2",
      accessTokenEnc: "ciphertext", metadata: { identityOnly: true }, createdAt: 1, updatedAt: 1,
    });
    await db.insert(githubInstallations).values({
      id: "ghi-1", orgId: "org-1", installationId: 111, accountLogin: "acme",
      accountType: "Organization", createdAt: 1, updatedAt: 1,
    });
    const identity = await resolveWorkflowCredentialIdentity({
      db, orgId: "org-1", owner: { type: "user", id: "user-1" }, service: "github",
      credential: "auto", params: { owner: "other", repo: "api" }, orgProvided: false,
      credentialRequired: true, now: 1_000,
    });
    expect(identity).toBe("github-installation:111");
  });

  it("expires approvals and supersedes the active row for a node", async () => {
    const write = (fingerprint: string, now: number) => writeWorkflowToolApproval(db, {
      ...base, fingerprint, approvedBy: "user-1", sourceRunId: `run-${now}`, now,
    });
    await write("fingerprint-1", 100);
    await write("fingerprint-2", 200);

    const rows = await db.select().from(workflowToolApprovals);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.fingerprint === "fingerprint-1")?.revokedAt).toBe(200);
    expect(rows.find((row) => row.fingerprint === "fingerprint-2")?.revokedAt).toBeNull();
    expect(await listWorkflowToolApprovals(db, base.workflowId, 201)).toHaveLength(1);

    const afterTtl = 200 + 91 * 24 * 60 * 60 * 1_000;
    expect(await findWorkflowToolApproval(db, "fingerprint-2", afterTtl)).toBeUndefined();
    await write("fingerprint-3", afterTtl);
    const cleaned = await db.select().from(workflowToolApprovals);
    expect(cleaned.map((row) => row.fingerprint)).toEqual(["fingerprint-3"]);
  });

  it("keeps one active row when distinct fingerprints are approved concurrently", async () => {
    const write = (fingerprint: string, now: number) => writeWorkflowToolApproval(db, {
      ...base, fingerprint, approvedBy: "user-1", sourceRunId: `run-${now}`, now,
    });
    await Promise.all([
      write("concurrent-fingerprint-1", 300),
      write("concurrent-fingerprint-2", 301),
    ]);

    const rows = await db.select().from(workflowToolApprovals);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.revokedAt === null)).toHaveLength(1);
  });
});
