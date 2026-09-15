import type { ResourceAuthorizationContext, ResourceAuthorizationPort } from "../authorization/resource-authorization.js";
import type { ResourceOperation } from "../authorization/route-resource-policy.js";

export class PolicyResourceAuthorization {
  constructor(
    private readonly port: ResourceAuthorizationPort,
    private readonly context: ResourceAuthorizationContext,
  ) {}

  async authorize(operation: Extract<ResourceOperation, "list" | "read" | "create" | "update" | "delete" | "approve" | "publish">, resource?: { id?: string; ownerType?: "user" | "team" | "org"; ownerId?: string; version?: number }): Promise<void> {
    const plan = await this.port.authorize({ ...this.context, resourceKind: "policy", operation, ...(resource ? { resource } : {}) });
    if (plan.resultLimit !== undefined || plan.fieldMask !== undefined || plan.redactions.length > 0 || plan.readOnly) {
      throw new Error("Policy service cannot enforce the required resource obligation.");
    }
  }
}
