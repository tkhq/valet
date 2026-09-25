import { createHash, randomUUID } from "node:crypto";
import type { BlobStore, PluginStore, Principal } from "@valet/engine";
import type {
  BrowserArtifact,
  BrowserIdentity,
  BrowserOperationReceipt,
  BrowserPolicyRequest,
  BrowserPolicyService,
  BrowserSettings,
} from "@valet/shared";

interface BrowserPolicyOptions {
  store: PluginStore;
  owner(sessionId: string): Promise<Principal | null>;
  isMember(owner: Principal, actorId: string): Promise<boolean>;
  isAdmin(owner: Principal, actorId: string): Promise<boolean>;
  blobs?: BlobStore;
}

export class BrowserPolicy implements BrowserPolicyService {
  constructor(private readonly options: BrowserPolicyOptions) {}

  async settings(sessionId: string): Promise<BrowserSettings> {
    const stored = await this.options.store
      .session(sessionId)
      .get<BrowserSettings>("settings", "browser");
    return (
      stored?.doc ?? {
        enabled: true,
        audience: "owner",
        policyVersion: "default",
        grants: [],
      }
    );
  }

  private async requireOwner(identity: BrowserIdentity): Promise<Principal> {
    const owner = await this.options.owner(identity.sessionId);
    if (!owner || owner.id !== identity.ownerId)
      throw new Error("Browser ownership changed. Reopen the session.");
    return owner;
  }

  async authorize(
    identity: BrowserIdentity,
  ): Promise<{ policyVersion: string }> {
    const owner = await this.requireOwner(identity);
    const settings = await this.settings(identity.sessionId);
    if (!settings.enabled)
      throw new Error(
        "The browser is disabled. Ask the session owner to enable it.",
      );
    if (owner.type === "user" && identity.actorId !== owner.id)
      throw new Error(
        "Browser access denied. Ask the session owner to use the browser.",
      );
    if (owner.type !== "user") {
      if (owner.type !== "team" || settings.audience !== "team")
        throw new Error(
          "The team browser is private by default. A team admin must enable shared browser access.",
        );
      if (!(await this.options.isMember(owner, identity.actorId)))
        throw new Error(
          "Browser access denied. Ask a team admin to restore your membership.",
        );
    }
    return { policyVersion: settings.policyVersion };
  }

  async updateSettings(
    identity: BrowserIdentity,
    update: Omit<BrowserSettings, "policyVersion">,
  ): Promise<BrowserSettings> {
    const owner = await this.requireOwner(identity);
    if (!(await this.options.isAdmin(owner, identity.actorId)))
      throw new Error(
        "Only the owner or team admin can change browser access. Ask an admin.",
      );
    if (owner.type !== "team" && update.audience === "team")
      throw new Error("This is a personal session. Select the owner audience.");
    for (const grant of update.grants) {
      let origin: URL;
      try {
        origin = new URL(grant.origin);
      } catch {
        throw new Error(
          "The browser grant origin is invalid. Use an HTTP or HTTPS origin.",
        );
      }
      if (
        !["http:", "https:"].includes(origin.protocol) ||
        origin.origin !== grant.origin ||
        grant.expiresAt <= Date.now()
      ) {
        throw new Error(
          "The browser grant is invalid. Use an exact origin and a future expiry.",
        );
      }
    }
    const settings: BrowserSettings = {
      ...update,
      policyVersion: randomUUID(),
    };
    await this.options.store
      .session(identity.sessionId)
      .put("settings", "browser", settings);
    return settings;
  }

  async decide(request: BrowserPolicyRequest) {
    const identity = { ...request, protocolVersion: "1.0" as const };
    const access = await this.authorize(identity);
    if (
      request.policyVersion !== access.policyVersion ||
      request.expiresAt <= Date.now()
    ) {
      return {
        decision: "deny" as const,
        ...access,
        reason:
          "The browser policy or approval expired. Start a new operation.",
      };
    }
    // Method classes do not identify business effects. The browser skill requires
    // task authorization, with ask_approval for unapproved consequential actions.
    if (
      ["observation", "navigation", "mutation", "history", "diagnostic"].includes(
        request.operationClass,
      )
    )
      return { decision: "allow" as const, ...access };
    const settings = await this.settings(request.sessionId);
    const granted = settings.grants.some(
      (grant) =>
        grant.origin === request.origin &&
        grant.expiresAt > Date.now() &&
        grant.operations.includes(request.operationClass),
    );
    return {
      decision: granted ? ("allow" as const) : ("ask" as const),
      ...access,
    };
  }

  async approve(request: BrowserPolicyRequest, resolvedBy: string) {
    const original = await this.authorize({
      ...request,
      protocolVersion: "1.0",
    });
    await this.authorize({
      ...request,
      protocolVersion: "1.0",
      actorId: resolvedBy,
    });
    if (request.expiresAt <= Date.now())
      throw new Error(
        "The browser approval expired. Inspect the page and request a new operation.",
      );
    if (request.policyVersion !== original.policyVersion)
      throw new Error(
        "Browser access changed after this request. Inspect the page and request a new operation.",
      );
    return original;
  }

  async audit(
    identity: BrowserIdentity,
    receipt: BrowserOperationReceipt,
  ): Promise<void> {
    // Never retain result bodies, page text, typed text, cookies or URL query strings.
    await this.options.store
      .session(identity.sessionId)
      .put("audit", `${receipt.cellId}:${receipt.operationId}`, {
        operationId: receipt.operationId,
        cellId: receipt.cellId,
        actorId: identity.actorId,
        threadId: identity.threadId,
        method: receipt.method,
        hash: receipt.hash,
        status: receipt.status,
        errorCode: receipt.error?.code,
        updatedAt: Date.now(),
      });
  }

  async auditRecords(identity: BrowserIdentity): Promise<unknown[]> {
    await this.authorize(identity);
    const page = await this.options.store
      .session(identity.sessionId)
      .list("audit", { limit: 1000 });
    return page.items.map((entry) => entry.doc);
  }

  async persistArtifact(
    identity: BrowserIdentity,
    artifact: BrowserArtifact,
    data: Uint8Array,
  ): Promise<BrowserArtifact> {
    await this.authorize(identity);
    if (!this.options.blobs)
      throw new Error(
        "Browser evidence storage is unavailable. Configure the host blob store.",
      );
    if (
      artifact.sessionId !== identity.sessionId ||
      data.byteLength !== artifact.bytes ||
      createHash("sha256").update(data).digest("hex") !== artifact.sha256
    )
      throw new Error(
        "Browser evidence identity or integrity changed. Capture new evidence.",
      );
    const key = this.evidenceKey(identity.sessionId, artifact.id);
    await this.options.blobs.put(key, data, { contentType: artifact.mimeType });
    const saved = {
      ...artifact,
      url: `/api/sessions/${encodeURIComponent(identity.sessionId)}/browser/evidence/${encodeURIComponent(artifact.id)}`,
    };
    await this.options.store
      .session(identity.sessionId)
      .put("evidence", artifact.id, saved);
    return saved;
  }

  evidenceKey(sessionId: string, artifactId: string): string {
    return `browser/${encodeURIComponent(sessionId)}/${encodeURIComponent(artifactId)}`;
  }
}
