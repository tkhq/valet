/**
 * A full-shape `PluginActionContext` for the action suites. The GitHub actions
 * read only `credentials.get()`, but the context type is wide, so every member
 * is present and every unused method throws. Follows the `fakeContext` helper
 * in `packages/sdk/src/mcp/action-plugin.test.ts` — no casts, so a change to
 * `ToolContext` shows up as a compile error here instead of a runtime surprise.
 */
import type { Credential, PluginActionContext } from "@valet/engine";

export function fakeActionContext(
  accessToken: string | null,
  /**
   * Credentials for explicit `.get(service)` reads, keyed by service name
   * (e.g. `"github:installation"`). A service absent from the map resolves
   * `null`, like a host without that resolver seam. A bare `.get()` or
   * `.get("github")` returns the default `accessToken` credential.
   */
  serviceCredentials: Record<string, string> = {},
): PluginActionContext {
  const notImplemented = (): never => {
    throw new Error("not implemented in the plugin-github test fixture");
  };
  const credential: Credential | null = accessToken === null ? null : { accessToken };

  return {
    actionId: "github.test",
    service: "github",
    userId: "user-1",
    orgId: "org-1",
    sessionId: "session-1",
    threadId: "thread-1",
    credentials: {
      get: async (service?: string) => {
        if (service === undefined || service === "github") return credential;
        const token = serviceCredentials[service];
        return token === undefined ? null : { accessToken: token };
      },
      request: async () => notImplemented(),
    },
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
      exec: async () => notImplemented(),
    },
    requestDecision: async () => notImplemented(),
    signal: new AbortController().signal,
    threadRead: async () => notImplemented(),
    listThreads: async () => notImplemented(),
    setModel: async () => notImplemented(),
  };
}
