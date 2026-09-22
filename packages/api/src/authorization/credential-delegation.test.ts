import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Principal } from "@valet/engine";
import type { AuthorizationRequest, DelegationEnvelopeV1 } from "@valet/engine/authorization";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, childWatches, credentialDelegations, delegationEnvelopes, sessionRepos } from "../schema/index.js";
import type { RepoBinding } from "../wire/types.js";
import {
  assertRepositoryCredentialDelegation,
  authorizeRepositoryCredentialDelegation,
  CredentialDelegationInvalidError,
  revokeChildCredentialDelegations,
} from "./credential-delegation.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CHILD_ID = "child-credential-delegation";
const BINDING: RepoBinding = {
  host: "github",
  fullName: "acme/widgets",
  cloneUrl: "https://github.com/acme/widgets.git",
  auth: "auto",
};

let api: TestApi | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await api?.cleanup();
  api = undefined;
});

function allowCredentialDelegation(a: TestApi): void {
  const preview = a.providers.canonicalAuthorizationService.preview.bind(a.providers.canonicalAuthorizationService);
  vi.spyOn(a.providers.canonicalAuthorizationService, "preview").mockImplementation(async (request: AuthorizationRequest) => {
    const envelope = await preview(request);
    const { decisionDigest: _decisionDigest, obligationDigest: _obligationDigest, decision: _decision, ...identity } = envelope;
    return {
      ...identity,
      decision: {
        effect: "allow",
        reasonCode: "test.allow",
        matchedRuleIds: ["test.allow"],
        obligations: [],
        redactions: [],
      },
    };
  });
}

async function seedChildState(now: number): Promise<void> {
  const envelope: DelegationEnvelopeV1 = {
    schemaVersion: 1,
    organizationId: "local-org",
    parentSessionId: "parent-credential-delegation",
    parentThreadId: "web:default",
    childSessionId: CHILD_ID,
    actorUserId: "local-user",
    owner: { type: "user", id: "local-user" },
    depth: 1,
    parentRootCapable: true,
    constraints: {},
    capabilities: ["repository.read"],
    policyDigest: "test-policy",
    sourceBundleDigest: "test-source",
    evaluatorKind: "local_valet",
    engineDigest: "test-engine",
  };
  await api!.providers.db.insert(delegationEnvelopes).values({
    childSessionId: CHILD_ID,
    orgId: "local-org",
    parentSessionId: "parent-credential-delegation",
    envelope,
    decisionId: "test-delegation-envelope",
    createdAt: now,
  });
  await api!.providers.db.insert(agentSessions).values({
    id: "parent-credential-delegation",
    userId: "local-user",
    orgId: "local-org",
    workspace: "/tmp/parent-credential-delegation",
    status: "active",
    ownerType: "user",
    ownerId: "local-user",
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  });
  await api!.providers.db.insert(agentSessions).values({
    id: CHILD_ID,
    userId: "local-user",
    orgId: "local-org",
    workspace: "/tmp/child-credential-delegation",
    status: "active",
    ownerType: "user",
    ownerId: "local-user",
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  });
  await api!.providers.db.insert(childWatches).values({
    childSessionId: CHILD_ID,
    queueItemId: "child-queue-item",
    parentSessionId: "parent-credential-delegation",
    parentThreadId: "web:default",
    actorUserId: "local-user",
    orgId: "local-org",
    settled: false,
    createdAt: now,
  });
  await api!.providers.db.insert(sessionRepos).values({
    sessionId: CHILD_ID,
    host: "github",
    fullName: BINDING.fullName,
    cloneUrl: BINDING.cloneUrl,
    ref: null,
    auth: BINDING.auth,
    position: 0,
  });
}

async function createGrant(now: number, owner: Principal = { type: "user", id: "local-user" }): Promise<void> {
  await authorizeRepositoryCredentialDelegation({
    db: api!.providers.db,
    authorization: api!.providers.canonicalAuthorizationService,
    orgId: "local-org",
    actorUserId: "local-user",
    owner,
    parentSessionId: "parent-credential-delegation",
    parentThreadId: "web:default",
    parentQueueItemId: "parent-queue-item",
    childSessionId: CHILD_ID,
    binding: BINDING,
    now,
  });
}

describe("repository credential delegation", () => {
  it("allows exact clone, fetch, and push until the 24-hour boundary", async () => {
    api = await bootTestApi();
    allowCredentialDelegation(api);
    const now = Date.now();
    await api.providers.engineCredentials.save({ type: "user", id: "local-user" }, "github", {
      type: "api_key",
      accessToken: "secret-canary-not-persisted",
    });
    await createGrant(now);
    await seedChildState(now);

    for (const operation of ["repository.clone", "repository.fetch", "repository.push"] as const) {
      await expect(assertRepositoryCredentialDelegation({
        db: api.providers.db,
        orgId: "local-org",
        actorUserId: "local-user",
        childSessionId: CHILD_ID,
        owner: { type: "user", id: "local-user" },
        binding: BINDING,
        operation,
        now: now + DAY_MS - 1,
      })).resolves.toBeUndefined();
    }

    await expect(assertRepositoryCredentialDelegation({
      db: api.providers.db,
      orgId: "local-org",
      actorUserId: "local-user",
      childSessionId: CHILD_ID,
      owner: { type: "user", id: "local-user" },
      binding: BINDING,
      operation: "repository.fetch",
      now: now + DAY_MS,
    })).rejects.toBeInstanceOf(CredentialDelegationInvalidError);

    const [grant] = await api.providers.db.select().from(credentialDelegations);
    expect(grant).toMatchObject({ childWatchId: CHILD_ID, issuedAt: now, expiresAt: now + DAY_MS,
      decisionEvidence: { effect: "allow", reasonCode: "test.allow" } });
    expect(JSON.stringify(grant)).not.toContain("secret-canary-not-persisted");
    await expect(api.providers.db.update(credentialDelegations).set({ ownerId: "tampered" }).where(eq(credentialDelegations.id, grant!.id))).rejects.toThrow();
    await revokeChildCredentialDelegations(api.providers.db, CHILD_ID, now + 1);
    await revokeChildCredentialDelegations(api.providers.db, CHILD_ID, now + 2);
    const [revoked] = await api.providers.db.select().from(credentialDelegations);
    expect(revoked).toMatchObject({ ownerId: "local-user", revokedAt: now + 1 });
  });

  it("rejects a different repository", async () => {
    api = await bootTestApi();
    allowCredentialDelegation(api);
    const now = Date.now();
    await createGrant(now);
    await seedChildState(now);

    await expect(assertRepositoryCredentialDelegation({
      db: api.providers.db,
      orgId: "local-org",
      actorUserId: "local-user",
      childSessionId: CHILD_ID,
      owner: { type: "user", id: "local-user" },
      binding: { ...BINDING, fullName: "acme/other", cloneUrl: "https://github.com/acme/other.git" },
      operation: "repository.clone",
      now,
    })).rejects.toBeInstanceOf(CredentialDelegationInvalidError);
  });

  it("does not bind a team grant to the prompting actor's personal token", async () => {
    api = await bootTestApi();
    allowCredentialDelegation(api);
    await api.providers.engineCredentials.save({ type: "user", id: "local-user" }, "github", {
      type: "api_key",
      accessToken: "personal-token-must-not-delegate",
    });
    await createGrant(Date.now(), { type: "team", id: "team-1" });

    const [grant] = await api.providers.db.select().from(credentialDelegations);
    expect(grant?.ownerType).toBe("team");
    expect(grant?.credentialKind).toBe("none");
    expect(JSON.stringify(grant)).not.toContain("personal-token-must-not-delegate");
  });
});
