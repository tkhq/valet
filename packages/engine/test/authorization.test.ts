import { describe, expect, expectTypeOf, it } from "vitest";
import {
  authorizationIdentity,
  interactiveAuthorizationSubject,
  resourceAuthorizationSubject,
  routeAuthorizationSubject,
  workflowAuthorizationSubject,
} from "../src/authorization/identity.js";
import type { AuthorizationRequest, PolicyDecisionV1 } from "../src/authorization/types.js";

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
});

describe("authorization identities", () => {
  const principal = { type: "user", id: "user-1" } as const;
  const action = { id: "github.issue.create", service: "github", parameters: { title: "Fix it" } };

  it("keeps interactive identity stable across a restart replay", () => {
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
    const first = authorizationIdentity({ kind: "tool.action", subject: interactiveAuthorizationSubject(input), action });
    const replay = authorizationIdentity({
      kind: "tool.action",
      subject: interactiveAuthorizationSubject({ ...input }),
      action: { parameters: { title: "Fix it" }, service: "github", id: "github.issue.create" },
    });

    expect(replay).toEqual(first);
  });

  it("uses durable workflow, route, and resource operation identities", () => {
    const workflow = workflowAuthorizationSubject({
      orgId: "org-1",
      principal,
      workflowExecutionId: "run-1",
      workflowNodeId: "node-1",
      invocationId: "invocation-1",
    });
    const route = routeAuthorizationSubject({ orgId: "org-1", principal, operationId: "operation-1" });
    const resource = resourceAuthorizationSubject({ orgId: "org-1", principal, operationId: "operation-2" });

    expect(authorizationIdentity({ kind: "workflow.action", subject: workflow, action }).idempotencyKey).toBe(
      "workflow:invocation-1",
    );
    expect(authorizationIdentity({ kind: "route.access", subject: route, action: { id: "route.read" } }).idempotencyKey).toBe(
      "route:operation-1",
    );
    expect(
      authorizationIdentity({ kind: "resource.access", subject: resource, action: { id: "resource.update" } }).idempotencyKey,
    ).toBe("resource:operation-2");
  });

  it("changes the request subject when action parameters change", () => {
    const subject = interactiveAuthorizationSubject({
      orgId: "org-1",
      principal,
      sessionId: "session-1",
      threadId: "thread-1",
      queueItemId: "queue-1",
      resumeKey: "tool-call-1",
      gateOrdinal: 1,
    });
    const first = authorizationIdentity({ kind: "tool.action", subject, action });
    const changed = authorizationIdentity({
      kind: "tool.action",
      subject,
      action: { ...action, parameters: { title: "Different" } },
    });

    expect(changed.requestSubjectDigest).not.toBe(first.requestSubjectDigest);
    expect(changed.idempotencyKey).toBe(first.idempotencyKey);
  });

  it("changes the request subject when the resource ID changes", () => {
    const subject = resourceAuthorizationSubject({ orgId: "org-1", principal, operationId: "operation-1" });
    const resource = { type: "repository", id: "repo-1" };
    const first = authorizationIdentity({ kind: "resource.access", subject, action, resource });
    const changed = authorizationIdentity({
      kind: "resource.access",
      subject,
      action,
      resource: { ...resource, id: "repo-2" },
    });

    expect(changed.requestSubjectDigest).not.toBe(first.requestSubjectDigest);
  });
});
