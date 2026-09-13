import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import {
  actionPolicies,
  orgMembers,
  policyAuthoringAudit,
  policyAuthoringDocuments,
  policyAuthoringOperations,
  policyAuthoringReviews,
  policyAuthoringRevisions,
  teamMembers,
  teams,
} from "../schema/index.js";
import { PolicyAuthoringService } from "../authorization/builder/service.js";
import { normalizePolicyDraft } from "../authorization/builder/model.js";
import type { PolicyDraftV1 } from "../authorization/builder/types.js";

let api: TestApi | undefined;
afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});
const headers = { "Content-Type": "application/json" },
  reviewer = { ...headers, "x-valet-test-user-id": "test-member" };
const draft: PolicyDraftV1 = {
  schemaVersion: 1,
  draftId: "authoring-draft-1",
  rules: [
    {
      ruleId: "rule-1",
      context: "tool.action",
      authority: "organization",
      owner: { kind: "org", id: "local-org" },
      subjects: ["org"],
      target: { "action.service": "gmail" },
      matcherGroups: [
        {
          id: "group-1",
          mode: "all",
          matchers: [
            {
              id: "match-1",
              field: "parameters.operation",
              operator: "eq",
              value: "send",
            },
          ],
        },
      ],
      effect: "deny",
      appliesIn: "any",
      obligations: [],
      description: "",
      metadata: {},
    },
  ],
};
const mutation = (key: string, revision: number, stateVersion: number) => ({
  schemaVersion: 1 as const,
  expectedRevision: revision,
  expectedStateVersion: stateVersion,
  idempotencyKey: key,
});
async function post(path: string, body: unknown, h = headers) {
  return fetch(`${api!.baseUrl}/api${path}`, {
    method: "POST",
    headers: h,
    body: JSON.stringify(body),
  });
}
async function setup() {
  api = await bootTestApi();
  return api;
}

describe("canonical policy authoring routes", () => {
  it("binds a reviewed immutable candidate without changing live policy", async () => {
    const app = await setup();
    const created = await post("/org/policy-drafts", {
      ...mutation("create-key-0001", 0, 0),
      draft,
    });
    expect(created.status).toBe(201);
    const first = (await created.json()) as {
      revision: number;
      stateVersion: number;
      status: string;
      sourceBundleDigest: string;
      normalizedIdentity: string;
    };
    expect(first).toMatchObject({
      revision: 1,
      stateVersion: 1,
      status: "draft",
    });
    const retry = await post("/org/policy-drafts", {
      ...mutation("create-key-0001", 0, 0),
      draft,
    });
    expect(await retry.json()).toEqual(first);
    expect(
      (
        await post("/org/policy-drafts", {
          ...mutation("create-key-0001", 0, 0),
          draft: { ...draft, draftId: "other-draft" },
        })
      ).status,
    ).toBe(409);
    const [winner, loser] = await Promise.all([
      post(`/org/policy-drafts/${draft.draftId}/submit-review`, mutation("submit-key-001", 1, 1)),
      post(`/org/policy-drafts/${draft.draftId}/submit-review`, mutation("submit-key-002", 1, 1)),
    ]);
    expect([winner.status, loser.status].sort()).toEqual([200, 409]);
    const submitted = (await (winner.status === 200 ? winner : loser).json()) as { stateVersion: number };
    expect(
      (
        await post(`/org/policy-drafts/${draft.draftId}/reviews`, {
          ...mutation("review-key-self", 1, submitted.stateVersion),
          verdict: "approve",
          requestId: "request-self",
        })
      ).status,
    ).toBe(403);
    await app.providers.db
      .update(orgMembers)
      .set({ role: "admin" })
      .where(and(eq(orgMembers.orgId, "local-org"), eq(orgMembers.userId, "test-member")));
    const approved = await post(
      `/org/policy-drafts/${draft.draftId}/reviews`,
      {
        ...mutation("review-key-001", 1, submitted.stateVersion),
        verdict: "approve",
        requestId: "request-1",
      },
      reviewer,
    );
    expect(approved.status).toBe(200);
    const candidate = (await approved.json()) as {
      status: string;
      stateVersion: number;
    };
    expect(candidate.status).toBe("approved_for_publication");
    const prepared = await post(
      `/org/policy-drafts/${draft.draftId}/prepare-publication`,
      {
        schemaVersion: 1,
        expectedRevision: 1,
        expectedStateVersion: candidate.stateVersion,
      },
      reviewer,
    );
    expect(prepared.status).toBe(200);
    expect(await prepared.json()).toMatchObject({
      notice: expect.stringContaining("no enforcement effect"),
    });
    expect(await app.providers.db.select().from(actionPolicies)).toEqual([]);
    expect(await app.providers.db.select().from(policyAuthoringRevisions)).toHaveLength(1);
    expect(await app.providers.db.select().from(policyAuthoringReviews)).toHaveLength(1);
    const changed = {
      ...draft,
      rules: [{ ...draft.rules[0], effect: "allow" as const }],
    };
    const edited = await fetch(`${app.baseUrl}/api/org/policy-drafts/${draft.draftId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        ...mutation("edit-key-00001", 1, candidate.stateVersion),
        draft: changed,
      }),
    });
    expect(edited.status).toBe(200);
    const second = (await edited.json()) as {
      revision: number;
      stateVersion: number;
      status: string;
    };
    expect(second).toMatchObject({ revision: 2, status: "draft" });
    const difference = await fetch(`${app.baseUrl}/api/org/policy-drafts/${draft.draftId}/diff?from=1&to=2`, { headers });
    expect(await difference.json()).toMatchObject({
      changedRuleIds: ["rule-1"],
      regoChanged: true,
      dataChanged: true,
      provenanceChanged: false,
    });
    const restored = await post(`/org/policy-drafts/${draft.draftId}/restore/1`, mutation("restore-key-001", 2, second.stateVersion));
    expect(await restored.json()).toMatchObject({
      revision: 3,
      status: "draft",
      normalizedIdentity: first.normalizedIdentity,
    });
    expect(await app.providers.db.select().from(policyAuthoringRevisions)).toHaveLength(3);
    expect(await app.providers.db.select().from(policyAuthoringAudit)).toHaveLength(5);
  }, 120_000);

  it("validates scope, unknown fields, spoofed identity, and preview privacy", async () => {
    const app = await setup();
    expect(
      (
        await post("/org/policy-drafts", {
          ...mutation("invalid-key-001", 0, 0),
          draft,
          actorId: "test-member",
        })
      ).status,
    ).toBe(400);
    const wrong = {
      ...draft,
      draftId: "wrong-scope",
      rules: [{ ...draft.rules[0], owner: { kind: "org" as const, id: "other-org" } }],
    };
    expect(
      (
        await post("/org/policy-drafts", {
          ...mutation("invalid-key-002", 0, 0),
          draft: wrong,
        })
      ).status,
    ).toBe(400);
    const preview = await post("/org/policy-drafts/preview", {
      schemaVersion: 1,
      draft,
      sampleFacts: {
        "parameters.operation": "send",
        "parameters.token": "sk-secret-not-allowed",
      },
      clientNormalizedIdentity: "policy-draft-v1:" + "0".repeat(64),
    });
    expect(preview.status).toBe(400);
    const log = vi.spyOn(console, "log");
    const ok = await post("/org/policy-drafts/preview", {
      schemaVersion: 1,
      draft,
      sampleFacts: {
        "parameters.operation": "send",
        "parameters.token": "sk-secret-not-allowed",
      },
    });
    expect(ok.status).toBe(200);
    const result = (await ok.json()) as {
      ranges: { ruleId: string; startLine: number; endLine: number }[];
      evaluation: { evaluator: { kind: string }; sourceBundleDigest: string; decision: { effect: string; matchedRuleIds: string[] } };
      sourceBundleDigest: string;
    };
    expect(result.ranges).toEqual(
      expect.arrayContaining([
        {
          ruleId: "rule-1",
          startLine: expect.any(Number),
          endLine: expect.any(Number),
        },
      ]),
    );
    expect(result.ranges.every((range) => range.endLine >= range.startLine)).toBe(true);
    expect(result.evaluation).toMatchObject({
      evaluator: { kind: "local_valet" },
      sourceBundleDigest: result.sourceBundleDigest,
    });
    expect(JSON.stringify(result).length).toBeLessThan(512 * 1024);
    const persisted = await Promise.all(
      [policyAuthoringDocuments, policyAuthoringRevisions, policyAuthoringOperations, policyAuthoringAudit].map((table) => app.providers.db.select().from(table)),
    );
    expect(JSON.stringify(persisted)).not.toContain("sk-secret");
    expect(JSON.stringify(log.mock.calls)).not.toContain("sk-secret");
    log.mockRestore();
  }, 120_000);

  it("conceals team documents and enforces the team operation matrix", async () => {
    const app = await setup();
    await app.providers.db.insert(teams).values([
      { id: "team-a", orgId: "local-org", name: "A", createdAt: 1 },
      { id: "team-b", orgId: "local-org", name: "B", createdAt: 1 },
    ]);
    await app.providers.db.insert(teamMembers).values({ teamId: "team-a", userId: "test-member", role: "member" });
    const teamDraft = {
      ...draft,
      draftId: "team-draft-1",
      rules: [
        {
          ...draft.rules[0],
          authority: "team" as const,
          owner: { kind: "team" as const, id: "team-a" },
          subjects: ["team" as const],
        },
      ],
    };
    expect((await post("/teams/team-a/policy-drafts", { ...mutation("team-create-001", 0, 0), draft: teamDraft }, reviewer)).status).toBe(403);
    expect((await fetch(`${app.baseUrl}/api/teams/team-b/policy-drafts/team-draft-1`, { headers: reviewer })).status).toBe(404);
    await app.providers.db.update(teamMembers).set({ role: "admin" }).where(eq(teamMembers.teamId, "team-a"));
    expect((await post("/teams/team-a/policy-drafts", { ...mutation("team-create-002", 0, 0), draft: teamDraft }, reviewer)).status).toBe(201);
    expect((await fetch(`${app.baseUrl}/api/teams/team-b/policy-drafts/team-draft-1`, { headers: reviewer })).status).toBe(404);
  }, 120_000);

  it("serializes concurrent CAS and idempotency claims", async () => {
    await setup();
    const concurrent = { ...draft, draftId: "concurrent-draft" },
      same = { ...mutation("concurrent-create-key", 0, 0), draft: concurrent };
    const [a, b] = await Promise.all([post("/org/policy-drafts", same), post("/org/policy-drafts", same)]);
    expect([a.status, b.status].sort()).toEqual([201, 201]);
    expect(await a.json()).toEqual(await b.json());
    const [x, y] = await Promise.all([
      post("/org/policy-drafts/concurrent-draft/submit-review", mutation("concurrent-cas-one", 1, 1)),
      post("/org/policy-drafts/concurrent-draft/submit-review", mutation("concurrent-cas-two", 1, 1)),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
  }, 120_000);

  it("recomputes identities and fails closed on malformed compilers", async () => {
    const app = await setup(),
      matchers = [
        ...draft.rules[0].matcherGroups[0].matchers,
        {
          id: "match-2",
          field: "parameters.label",
          operator: "eq" as const,
          value: "x",
        },
      ];
    const permutable = {
        ...draft,
        rules: [
          {
            ...draft.rules[0],
            matcherGroups: [{ ...draft.rules[0].matcherGroups[0], matchers }],
          },
        ],
      },
      permuted = {
        ...permutable,
        rules: [
          {
            ...permutable.rules[0],
            matcherGroups: [
              {
                ...permutable.rules[0].matcherGroups[0],
                matchers: [...matchers].reverse(),
              },
            ],
          },
        ],
      };
    const p1 = await post("/org/policy-drafts/preview", {
        schemaVersion: 1,
        draft: permutable,
        sampleFacts: {},
      }),
      p2 = await post("/org/policy-drafts/preview", {
        schemaVersion: 1,
        draft: permuted,
        sampleFacts: {},
      }),
      r1 = (await p1.json()) as {
        identity: string;
        sourceBundleDigest: string;
      },
      r2 = (await p2.json()) as typeof r1;
    expect(r1.identity).toBe(r2.identity);
    expect(r1.sourceBundleDigest).toBe(r2.sourceBundleDigest);
    expect(
      (
        await post("/org/policy-drafts", {
          ...mutation("spoof-draft-key", 0, 0),
          draft: {
            ...draft,
            normalizedIdentity: normalizePolicyDraft(draft).normalizedIdentity,
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post("/org/policy-drafts", {
          ...mutation("spoof-outer-key", 0, 0),
          draft,
          policyDigest: "a".repeat(64),
        })
      ).status,
    ).toBe(400);
    const scope = { organizationId: "local-org" },
      authorizer = { authorize: async () => true as const },
      compilers = [
        async () => {
          throw new Error("engine unavailable");
        },
        async () => ({
          validation: { valid: true, publishable: true, issues: [] },
        }),
        async () => ({
          validation: { valid: true, publishable: true, issues: [] },
          bundle: { manifestJson: "{}", files: [] },
          identity: {
            sourceBundleDigest: "bad",
            policyDigest: "bad",
            engineDigest: "bad",
          },
          source: { rego: "", data: "" },
        }),
      ];
    for (const [index, compile] of compilers.entries()) {
      const service = new PolicyAuthoringService({
        db: app.providers.db,
        authorizer,
        compiler: { compile, evaluate: async () => ({}) },
      } as never);
      await expect(
        service.create("actor", scope, {
          ...mutation(`malformed-key-${index}`, 0, 0),
          draft: { ...draft, draftId: `bad-draft-${index}` },
        }),
      ).rejects.toMatchObject({ code: "unsupported", statusCode: 422 });
    }
    const hash = "a".repeat(64),
      service = new PolicyAuthoringService({
        db: app.providers.db,
        authorizer,
        compiler: {
          compile: async () => ({
            validation: { valid: true, publishable: true, issues: [] },
            bundle: { manifestJson: "{}", files: [] },
            identity: {
              sourceBundleDigest: hash,
              policyDigest: hash,
              engineDigest: hash,
            },
            source: { rego: "", data: "" },
          }),
          evaluate: async () => {
            throw new Error("capability unavailable");
          },
        },
      });
    await expect(
      service.preview("actor", scope, {
        schemaVersion: 1,
        draft,
        sampleFacts: {},
      }),
    ).rejects.toMatchObject({ code: "unsupported", statusCode: 422 });
    expect(await app.providers.db.select().from(policyAuthoringDocuments)).toEqual([]);
  }, 120_000);

  it("rolls back every mutation when its durable audit write fails", async () => {
    const app = await setup(),
      scope = { organizationId: "local-org" },
      authorizer = { authorize: async () => true as const };
    const normal = new PolicyAuthoringService({
        db: app.providers.db,
        authorizer,
      }),
      failing = new PolicyAuthoringService({
        db: app.providers.db,
        authorizer,
        auditWrite: async () => {
          throw new Error("audit unavailable");
        },
      });
    const snapshot = async () =>
      JSON.stringify(
        await Promise.all(
          [policyAuthoringDocuments, policyAuthoringRevisions, policyAuthoringReviews, policyAuthoringOperations, policyAuthoringAudit].map((table) =>
            app.providers.db.select().from(table),
          ),
        ),
      );
    const rejectsWithoutChange = async (action: () => Promise<unknown>) => {
      const before = await snapshot();
      await expect(action()).rejects.toThrow("audit unavailable");
      expect(await snapshot()).toBe(before);
    };
    await rejectsWithoutChange(() =>
      failing.create("author", scope, {
        ...mutation("audit-create-fail", 0, 0),
        draft: { ...draft, draftId: "audit-create" },
      }),
    );
    const created = await normal.create("author", scope, {
      ...mutation("audit-base-create", 0, 0),
      draft,
    });
    await rejectsWithoutChange(() =>
      failing.edit("author", scope, draft.draftId, {
        ...mutation("audit-edit-fail", created.revision, created.stateVersion),
        draft,
      }),
    );
    await rejectsWithoutChange(() => failing.submit("author", scope, draft.draftId, mutation("audit-submit-fail", 1, 1)));
    const submitted = await normal.submit("author", scope, draft.draftId, mutation("audit-submit-ok", 1, 1));
    await rejectsWithoutChange(() =>
      failing.review("reviewer", scope, draft.draftId, {
        ...mutation("audit-review-fail", 1, submitted.stateVersion),
        verdict: "approve",
        requestId: "audit-review",
      }),
    );
    await rejectsWithoutChange(() => failing.restore("author", scope, draft.draftId, 1, mutation("audit-restore-fail", 1, submitted.stateVersion)));
  });
});
