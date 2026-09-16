/**
 * Fakes for the action and enrollment suites: a Turnkey client that records
 * calls and mints ids, a GitHub client that records keys, an in-memory
 * plugin store, a sandbox that records exec commands, and a full-shape
 * `PluginActionContext` with no casts.
 */
import type {
  Credential,
  DecisionGateRequest,
  DecisionResolution,
  PluginActionContext,
  PluginStore,
  PluginStoreDoc,
  PluginStoreScope,
  ScopedPluginStore,
} from "@valet/engine";
import type { GitHubSigningKeys } from "../github-keys.js";
import type { TurnkeyOps } from "../turnkey-client.js";

// Raw Ed25519 public key from `ssh-keygen`; see ssh.test.ts for the derived line and fingerprint.
export const RAW_ED25519_HEX = "2796666bc15775e2842aad75c07349961cda3f6a8fde5b2ccc5badff8d54e746";
export const EXPECTED_LINE = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICeWZmvBV3XihCqtdcBzSZYc2j9qj95bLMxbrf+NVOdG";
export const EXPECTED_FINGERPRINT = "SHA256:jAssneK/jlwaFI1LvXlWonG1n/EGYDTbTCp2lXzm1Xs";

export interface FakeTurnkey extends TurnkeyOps {
  calls: Array<{ op: string; args: unknown }>;
}

export function fakeTurnkey(): FakeTurnkey {
  const calls: FakeTurnkey["calls"] = [];
  const counters = new Map<string, number>();
  const id = (prefix: string) => {
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    return `${prefix}-${n}`;
  };
  return {
    calls,
    async createSubOrganization(args) {
      calls.push({ op: "createSubOrganization", args });
      return { subOrgId: id("suborg"), activityId: id("act") };
    },
    async createUsers(args) {
      calls.push({ op: "createUsers", args });
      return { userIds: args.users.map(() => id("user")), activityId: id("act") };
    },
    async createUserTag(args) {
      calls.push({ op: "createUserTag", args });
      return { tagId: id("utag") };
    },
    async createPrivateKeyTag(args) {
      calls.push({ op: "createPrivateKeyTag", args });
      return { tagId: id("ktag") };
    },
    async createPolicy(args) {
      calls.push({ op: "createPolicy", args });
      return { policyId: id("policy") };
    },
    async listRootUsers(args) {
      calls.push({ op: "listRootUsers", args });
      return [
        { userId: "passkey-user", userName: "passkey" },
        { userId: "parent-user", userName: "valet-parent" },
      ];
    },
    async updateRootQuorum(args) {
      calls.push({ op: "updateRootQuorum", args });
    },
    async createSigningKey(args) {
      calls.push({ op: "createSigningKey", args });
      return { privateKeyId: id("pk"), publicKeyHex: RAW_ED25519_HEX, activityId: id("act") };
    },
    async createApiKey(args) {
      calls.push({ op: "createApiKey", args });
      return { apiKeyId: id("apikey"), activityId: id("act") };
    },
    async deleteApiKeys(args) {
      calls.push({ op: "deleteApiKeys", args });
    },
  };
}

export interface FakeGitHub extends GitHubSigningKeys {
  keys: Map<number, { title: string; key: string }>;
  failCreateWith?: Error;
}

export function fakeGithub(): FakeGitHub {
  const keys = new Map<number, { title: string; key: string }>();
  let next = 100;
  const fake: FakeGitHub = {
    keys,
    async create(title, key) {
      if (fake.failCreateWith) throw fake.failCreateWith;
      const id = next++;
      keys.set(id, { title, key });
      return { id };
    },
    async remove(id) {
      keys.delete(id);
    },
  };
  return fake;
}

function scopeKey(scope: PluginStoreScope): string {
  return scope.type === "global" ? "global" : `${scope.type}:${scope.id}`;
}

export function memoryPluginStore(): PluginStore & { dump(): Map<string, PluginStoreDoc<unknown>> } {
  const rows = new Map<string, PluginStoreDoc<unknown>>();
  const scoped = (scope: PluginStoreScope): ScopedPluginStore => {
    const prefix = scopeKey(scope);
    const rowKey = (collection: string, key: string) => `${prefix}/${collection}/${key}`;
    return {
      async get<T>(collection: string, key: string) {
        const row = rows.get(rowKey(collection, key));
        return row ? (row as PluginStoreDoc<T>) : null;
      },
      async put<T>(collection: string, key: string, doc: T, opts?: { ifRevision?: number }) {
        const existing = rows.get(rowKey(collection, key));
        if (opts?.ifRevision !== undefined && existing?.revision !== opts.ifRevision) {
          throw new Error(`revision conflict on ${collection}/${key}`);
        }
        const now = Date.now();
        const row: PluginStoreDoc<T> = {
          key,
          doc,
          revision: (existing?.revision ?? 0) + 1,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        rows.set(rowKey(collection, key), row);
        return row;
      },
      async list<T>(collection: string, opts?: { prefix?: string; limit?: number }) {
        const head = `${prefix}/${collection}/`;
        const items = [...rows.entries()]
          .filter(([k]) => k.startsWith(head) && k.slice(head.length).startsWith(opts?.prefix ?? ""))
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([, v]) => v as PluginStoreDoc<T>)
          .slice(0, opts?.limit ?? 1000);
        return { items, nextCursor: null };
      },
      async delete(collection: string, key: string) {
        return rows.delete(rowKey(collection, key));
      },
    };
  };
  return {
    scope: scoped,
    global: () => scoped({ type: "global" }),
    org: (id) => scoped({ type: "org", id }),
    team: (id) => scoped({ type: "team", id }),
    user: (id) => scoped({ type: "user", id }),
    session: (id) => scoped({ type: "session", id }),
    dump: () => rows,
  };
}

export interface FakeContextOptions {
  githubToken?: string | null;
  decision?: (req: DecisionGateRequest) => Promise<DecisionResolution>;
  pluginStore?: PluginStore;
}

export function fakeContext(opts: FakeContextOptions = {}): PluginActionContext & { execs: string[]; gates: DecisionGateRequest[] } {
  const notImplemented = (): never => {
    throw new Error("not implemented in the plugin-turnkey test fixture");
  };
  const token = opts.githubToken === undefined ? "gh-token" : opts.githubToken;
  const credential: Credential | null = token === null ? null : { accessToken: token };
  const execs: string[] = [];
  const gates: DecisionGateRequest[] = [];
  return {
    execs,
    gates,
    actionId: "turnkey.test",
    service: "turnkey",
    userId: "user-1",
    orgId: "org-1",
    sessionId: "session-1",
    threadId: "thread-1",
    decisionGateId: "gate-1",
    credentials: {
      get: async (service?: string) => (service === "github" ? credential : null),
      request: async () => notImplemented(),
    },
    ...(opts.pluginStore ? { pluginStore: opts.pluginStore } : {}),
    sandbox: {
      id: "sandbox-1",
      readFile: async () => notImplemented(),
      readBinary: async () => notImplemented(),
      writeFile: async () => notImplemented(),
      writeBinary: async () => notImplemented(),
      readdir: async () => notImplemented(),
      stat: async () => notImplemented(),
      mkdir: async () => notImplemented(),
      rm: async () => notImplemented(),
      exec: async (command: string) => {
        execs.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    requestDecision: async (req) => {
      gates.push(req);
      if (opts.decision) return opts.decision(req);
      return { actionId: "approve", resolvedBy: "user-1", resolvedAt: Date.now() };
    },
    signal: new AbortController().signal,
    threadRead: async () => notImplemented(),
    listThreads: async () => notImplemented(),
    setModel: async () => notImplemented(),
  };
}
