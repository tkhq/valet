/**
 * `POST /api/sandbox/env` — Valet-in-Valet sandbox env-var minting.
 * Route-level: real Hono app via `bootTestApi`, a minted sandbox token for
 * auth, org LLM-provider row seeded directly, `ANTHROPIC_API_KEY` env stub
 * for the fallback branch.
 *
 * Security pins: missing/garbage sandbox token 401 (middleware); the org
 * credential wins over the env fallback; the key appears ONLY in the
 * response body; the response shape is stable when no key resolves
 * (`{anthropicApiKey: null}`, not a 500), so a keyless sandbox still boots.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { mintSandboxToken } from "../auth/sandbox-tokens.js";
import { createLlmProvider } from "../services/llm-providers.js";
import type { PostSandboxEnvResponse } from "../wire/types.js";

const SESSION_ID = "sess-env-1";
const ORG_ID = "local-org";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function mintToken(sessionId = SESSION_ID): Promise<string> {
  const { token } = await mintSandboxToken(api!.providers.db, {
    sessionId,
    userId: "local-user",
    orgId: ORG_ID,
  });
  return token;
}

async function saveOrgAnthropicKey(apiKey: string): Promise<void> {
  const row = await createLlmProvider(api!.providers.db, {
    orgId: ORG_ID,
    kind: "anthropic",
    name: "Anthropic",
  });
  await api!.providers.engineCredentials.save({ type: "org", id: ORG_ID }, `llm:${row.id}`, {
    type: "api_key",
    apiKey,
  });
}

function post(token: string | undefined): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== undefined) headers["x-valet-sandbox"] = token;
  return fetch(`${api!.baseUrl}/api/sandbox/env`, {
    method: "POST",
    headers,
    body: "{}",
  });
}

describe("POST /api/sandbox/env", () => {
  it("returns the org anthropic credential when one is set", async () => {
    api = await bootTestApi();
    await saveOrgAnthropicKey("sk-org-anthropic");
    // Env value is also present — the org key must win.
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-env-anthropic");
    const token = await mintToken();
    const res = await post(token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PostSandboxEnvResponse;
    expect(body.anthropicApiKey).toBe("sk-org-anthropic");
  });

  it("falls back to process.env.ANTHROPIC_API_KEY when no org credential exists", async () => {
    api = await bootTestApi();
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-env-anthropic");
    const token = await mintToken();
    const res = await post(token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PostSandboxEnvResponse;
    expect(body.anthropicApiKey).toBe("sk-env-anthropic");
  });

  it("returns anthropicApiKey: null when neither an org credential nor env key exists", async () => {
    api = await bootTestApi();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const token = await mintToken();
    const res = await post(token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PostSandboxEnvResponse;
    expect(body.anthropicApiKey).toBeNull();
  });

  it("rejects a missing sandbox token at the middleware (401)", async () => {
    api = await bootTestApi();
    const res = await post(undefined);
    expect(res.status).toBe(401);
  });

  it("does not log the resolved key", async () => {
    api = await bootTestApi();
    await saveOrgAnthropicKey("sk-org-secret-nolog");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const token = await mintToken();
    const res = await post(token);
    expect(res.status).toBe(200);
    const seen = [...logSpy.mock.calls, ...errSpy.mock.calls, ...warnSpy.mock.calls].flat();
    for (const arg of seen) {
      expect(String(arg)).not.toContain("sk-org-secret-nolog");
    }
  });
});
