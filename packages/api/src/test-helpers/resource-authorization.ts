import type { AuthorizationPrincipal } from "@valet/engine/authorization";
import type { ArtifactAuthorization } from "../services/artifacts.js";
import type { WorkflowOwner } from "../workflows/service.js";
import type { ResourceAuthorizationContext, ResourceAuthorizationPort } from "../authorization/resource-authorization.js";

export const ALLOW_RESOURCE_AUTHORIZATION: ResourceAuthorizationPort = {
  authorize: async () => ({ schemaVersion: 1, readOnly: false, redactions: [] }),
};

export function testResourceContext(
  organizationId = "local-org",
  actorUserId = "local-user",
  principal: AuthorizationPrincipal = { type: "user", id: actorUserId },
  deliveryId = crypto.randomUUID(),
): ResourceAuthorizationContext {
  return { organizationId, actorUserId, principal, deliveryId };
}

export function testWorkflowResourceContext(owner: WorkflowOwner): ResourceAuthorizationContext {
  return testResourceContext(owner.orgId, owner.userId, owner.principal ?? { type: "user", id: owner.userId });
}

export function allowArtifactAuthorization(organizationId = "local-org", actorUserId = "local-user", principal: AuthorizationPrincipal = { type: "user", id: actorUserId }): ArtifactAuthorization {
  return { port: ALLOW_RESOURCE_AUTHORIZATION, context: testResourceContext(organizationId, actorUserId, principal) };
}
