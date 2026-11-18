import { describe, expect, expectTypeOf, it } from "vitest";
import {
  authorizationIdentity,
  interactiveAuthorizationSubject,
  resourceAuthorizationSubject,
  routeAuthorizationSubject,
  workflowAuthorizationSubject,
} from "../src/authorization/identity.js";
import type { ApprovalAssurance, ApprovalFact, AuthorizationRequest, Obligation, PolicyDecisionV1 } from "../src/authorization/types.js";

type IsAssignable<Value, Target> = Value extends Target ? true : false;

describe("authorization contracts", () => {
  it("requires principal, request, action, and effect fields", () => {
    expectTypeOf<IsAssignable<Omit<AuthorizationRequest, "requestId">, AuthorizationRequest>>().toEqualTypeOf<false>();
    expectTypeOf<
      IsAssignable<
        Omit<AuthorizationRequest, "subject"> & { subject: Omit<AuthorizationRequest["subject"], "principal"> },
        AuthorizationRequest
      >
    >().toEqualTypeOf<false>();
    expectTypeOf<
      IsAssignable<
        Omit<AuthorizationRequest, "action"> & { action: Omit<AuthorizationRequest["action"], "id"> },
        AuthorizationRequest
      >
    >().toEqualTypeOf<false>();
    expectTypeOf<IsAssignable<Omit<PolicyDecisionV1, "effect">, PolicyDecisionV1>>().toEqualTypeOf<false>();
  });

  it("carries a proof of presence as an AuthZEN approval object", () => {
    const fact: ApprovalFact = {
      resolutionId: "r1",
      decisionDigest: "d",
      requestSubjectDigest: "s",
      effect: "approved",
      resolvedBy: "u1",
      resolvedAtMs: 1,
      assurance: "presence",
      approval: {
        id: "apr_1",
        approved_at: "2026-11-17T00:00:00.000Z",
        approved_until: "2026-11-17T00:00:00.000Z",
        state: { iss: "turnkey", amr: ["pop", "user"], activities: [{ activity_id: "act-1", payload_sha256: "ab" }] },
      },
    };
    expect(fact.approval?.id).toBe("apr_1");
    expectTypeOf<ApprovalAssurance>().toEqualTypeOf<"session" | "presence">();
    expectTypeOf<IsAssignable<{ type: "approval_tier"; tier: "high"; assurance: "presence" }, Obligation>>().toEqualTypeOf<true>();
    expectTypeOf<IsAssignable<{ type: "approval_tier"; tier: "high"; assurance: "biometric" }, Obligation>>().toEqualTypeOf<false>();
  });
});

describe("authorization identities", () => {
  const principal = { type: "user", id: "user-1" } as const;
  const action = { id: "github.issue.create", service: "github", parameters: { title: "Fix it" } };

  it("keeps interactive identity stable across a restart replay", async () => {
    const input = {
      orgId: "org-1",
      principal,
      actorUserId: "user-1",
      sessionId: "session-1",
      threadId: "thread-1",
      queueItemId: "queue-1",
      resumeKey: "tool-call-1",
      gateOrdinal: 2,
    };
    const first = await authorizationIdentity({
      kind: "tool.action",
      subject: await interactiveAuthorizationSubject(input),
      action,
    });
    const replay = await authorizationIdentity({
      kind: "tool.action",
      subject: await interactiveAuthorizationSubject({ ...input }),
      action: { parameters: { title: "Fix it" }, service: "github", id: "github.issue.create" },
    });

    expect(replay).toEqual(first);
  });

  it("hashes canonical JSON with SHA-256", async () => {
    const subject = routeAuthorizationSubject({ orgId: "org-1", principal, operationId: "operation-1" });
    const identity = await authorizationIdentity({ kind: "route.access", subject, action: { id: "route.read" } });

    expect(identity.requestSubjectDigest).toBe("9c041a0dc5ded60269c3256b0ad13b22889165a6ea0f5112137e276bf352ad1b");
  });

  it("omits optional undefined object properties recursively", async () => {
    const subject = routeAuthorizationSubject({ orgId: "org-1", principal, operationId: "operation-1" });
    const withUndefined = {
      ...subject,
      actorUserId: undefined,
      principal: { ...subject.principal, optional: undefined },
    };
    const omitted = await authorizationIdentity({
      kind: "route.access",
      subject,
      action: { id: "route.read" },
      resource: { type: "repository", id: "repo-1" },
    });
    const explicit = await authorizationIdentity({
      kind: "route.access",
      subject: withUndefined,
      action: { id: "route.read", service: undefined },
      resource: { type: "repository", id: "repo-1", ownerId: undefined },
    });

    expect(explicit).toEqual(omitted);
  });

  it("rejects values that have no JSON form", async () => {
    const subject = routeAuthorizationSubject({ orgId: "org-1", principal, operationId: "operation-1" });

    await expect(
      authorizationIdentity({ kind: "route.access", subject, action: { id: "route.read", parameters: { n: Number.NaN } } }),
    ).rejects.toThrow(TypeError);
  });

  it("uses durable workflow, route, and resource operation identities", async () => {
    const workflow = workflowAuthorizationSubject({
      orgId: "org-1",
      principal,
      workflowExecutionId: "run-1",
      workflowNodeId: "node-1",
      invocationId: "invocation-1",
    });
    const route = routeAuthorizationSubject({ orgId: "org-1", principal, operationId: "operation-1" });
    const resource = resourceAuthorizationSubject({ orgId: "org-1", principal, operationId: "operation-2" });

    expect((await authorizationIdentity({ kind: "workflow.action", subject: workflow, action })).idempotencyKey).toBe(
      "workflow:invocation-1",
    );
    expect(
      (await authorizationIdentity({ kind: "route.access", subject: route, action: { id: "route.read" } })).idempotencyKey,
    ).toBe("route:operation-1");
    expect(
      (await authorizationIdentity({ kind: "resource.access", subject: resource, action: { id: "resource.update" } }))
        .idempotencyKey,
    ).toBe("resource:operation-2");
  });

  it("changes the request subject when action parameters change", async () => {
    const subject = await interactiveAuthorizationSubject({
      orgId: "org-1",
      principal,
      sessionId: "session-1",
      threadId: "thread-1",
      queueItemId: "queue-1",
      resumeKey: "tool-call-1",
      gateOrdinal: 1,
    });
    const first = await authorizationIdentity({ kind: "tool.action", subject, action });
    const changed = await authorizationIdentity({
      kind: "tool.action",
      subject,
      action: { ...action, parameters: { title: "Different" } },
    });

    expect(changed.requestSubjectDigest).not.toBe(first.requestSubjectDigest);
    expect(changed.idempotencyKey).toBe(first.idempotencyKey);
  });

  it("changes the request subject when the resource ID changes", async () => {
    const subject = resourceAuthorizationSubject({ orgId: "org-1", principal, operationId: "operation-1" });
    const resource = { type: "repository", id: "repo-1" };
    const first = await authorizationIdentity({ kind: "resource.access", subject, action, resource });
    const changed = await authorizationIdentity({
      kind: "resource.access",
      subject,
      action,
      resource: { ...resource, id: "repo-2" },
    });

    expect(changed.requestSubjectDigest).not.toBe(first.requestSubjectDigest);
  });
});
