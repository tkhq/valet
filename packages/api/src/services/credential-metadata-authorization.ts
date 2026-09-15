import type { CredentialOwner, CredentialStore, StoredCredential } from "@valet/engine";
import { and, eq } from "drizzle-orm";
import type { AppQueryable } from "../lib/drizzle.js";
import { credentials } from "../schema/index.js";
import type { ResourceAuthorizationContext, ResourceAuthorizationPort } from "../authorization/resource-authorization.js";

export type CredentialMetadataOperation = "list" | "metadata" | "create" | "update" | "delete" | "attach";

export class CredentialMetadataAuthorization {
  constructor(
    private readonly db: AppQueryable,
    private readonly store: CredentialStore,
    private readonly port: ResourceAuthorizationPort,
    private readonly context: ResourceAuthorizationContext,
  ) {}

  async authorize(owner: CredentialOwner, operation: CredentialMetadataOperation, service?: string): Promise<void> {
    const row = service ? (await this.db.select({ updatedAt: credentials.updatedAt }).from(credentials).where(and(eq(credentials.ownerType, owner.type), eq(credentials.ownerId, owner.id), eq(credentials.service, service))).limit(1))[0] : undefined;
    const plan = await this.port.authorize({
      ...this.context,
      resourceKind: "secret",
      operation,
      resource: {
        ownerType: owner.type === "session" ? undefined : owner.type,
        ownerId: owner.id,
        ...(row ? { version: row.updatedAt } : {}),
      },
    });
    if (plan.resultLimit !== undefined || plan.fieldMask !== undefined || plan.redactions.length > 0 || plan.readOnly) {
      throw new Error("Credential metadata service cannot enforce the required resource obligation.");
    }
  }

  async list(owner: CredentialOwner) {
    await this.authorize(owner, "list");
    return this.store.list(owner);
  }

  async get(owner: CredentialOwner, service: string, operation: CredentialMetadataOperation = "metadata"): Promise<StoredCredential | null> {
    await this.authorize(owner, operation, service);
    return this.store.get(owner, service);
  }

  async save(owner: CredentialOwner, service: string, credential: StoredCredential): Promise<void> {
    await this.authorize(owner, "update", service);
    await this.store.save(owner, service, credential);
  }

  async delete(owner: CredentialOwner, service: string): Promise<void> {
    await this.authorize(owner, "delete", service);
    await this.store.delete(owner, service);
  }
}
