/**
 * Resolved tool counts for connected dynamic services on the `/api/plugins`
 * surface (integration-OAuth follow-up). Dynamic (`resolveActions`) plugins
 * declare zero static actions, so the connect UI's meta line can only say
 * "tools load on connect" — accurate before connecting, but unhelpful once
 * a credential exists. This resolver runs the plugin's own `resolveActions`
 * seam (the same one agent sessions use) against the caller's credential to
 * report a real count.
 *
 * Guardrails, since this sits on a page-load path and each resolve is a
 * live MCP network call:
 * - per owner+service TTL cache, with in-flight dedupe (no stampedes);
 * - a hard timeout that fails soft to `undefined` — the row falls back to
 *   its static label rather than the page blocking on a slow MCP server;
 * - errors are never cached, so a transient failure retries next load.
 */
import type {
  ActionPlugin,
  Credential,
  CredentialOwner,
  CredentialProvider,
  CredentialStore,
} from "@valet/engine";

const TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 2_500;

interface CacheEntry {
  count: number;
  at: number;
}

export class DynamicToolCounts {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<number | undefined>>();

  constructor(
    private readonly deps: {
      credentials: CredentialStore;
      now?: () => number;
      timeoutMs?: number;
    },
  ) {}

  /** Resolved tool count, or `undefined` on timeout/error (fail-soft). */
  async get(owner: CredentialOwner, service: string, actionPlugin: ActionPlugin): Promise<number | undefined> {
    const resolveActions = actionPlugin.resolveActions;
    if (!resolveActions) return undefined;
    const key = `${owner.type}:${owner.id}:${service}`;
    const now = (this.deps.now ?? Date.now)();

    const cached = this.cache.get(key);
    if (cached && now - cached.at < TTL_MS) return cached.count;

    const running = this.inflight.get(key);
    if (running) return running;

    const attempt = this.resolve(key, owner, service, resolveActions).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, attempt);
    return attempt;
  }

  private async resolve(
    key: string,
    owner: CredentialOwner,
    service: string,
    resolveActions: NonNullable<ActionPlugin["resolveActions"]>,
  ): Promise<number | undefined> {
    const credentials = this.credentialProvider(owner, service);
    let timer: NodeJS.Timeout | undefined;
    try {
      const count = await Promise.race([
        resolveActions({ credentials }).then((actions) => actions.length),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        }),
      ]);
      if (count === undefined) return undefined; // timed out — don't cache
      this.cache.set(key, { count, at: (this.deps.now ?? Date.now)() });
      return count;
    } catch {
      // Resolution failure (no credential, MCP error) — the row keeps its
      // static label; sessions surface the real error via list_tools.
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Same StoredCredential→Credential mapping as `action-invoker.ts`'s provider. */
  private credentialProvider(owner: CredentialOwner, defaultService: string): CredentialProvider {
    const store = this.deps.credentials;
    return {
      async get(service?: string): Promise<Credential | null> {
        const stored = await store.get(owner, service ?? defaultService);
        if (!stored) return null;
        const accessToken = stored.accessToken ?? stored.apiKey ?? "";
        if (accessToken === "") return null;
        return {
          accessToken,
          refreshToken: stored.refreshToken,
          expiresAt: stored.expiresAt,
          scopes: stored.scopes,
          metadata: stored.metadata,
        };
      },
      request(): Promise<Credential> {
        return Promise.reject(new Error("credential requests are not supported in the plugins listing"));
      },
    };
  }
}
