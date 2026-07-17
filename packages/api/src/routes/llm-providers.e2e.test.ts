/**
 * LLM providers — exit-criteria e2e (llm-providers design doc "Exit criteria"
 * section; plan Task 9). Fixture-first: real `createApp` + real engine turns,
 * but every LLM call is intercepted by `registerFauxProvider` (no network, no
 * real API key required) so this runs unconditionally in the "unit" vitest
 * project (env-scrubbed by `vitest.setup.ts`; `vi.stubEnv` sits on top of that
 * clean base). The live-network counterpart (`OPENAI_API_KEY`-gated, one real
 * OpenAI turn) is `src/integration/llm-providers.e2e.test.ts`.
 *
 * Walks the design doc's dogfood story end to end over real HTTP + WS:
 *   1. Zero-config boot (env key only) → admin adds an org Anthropic key →
 *      turns use it, not env. Rotate the key → the very next turn sees the
 *      new one, no reboot.
 *   2. Custom (openai_compatible) provider: create, probe against a fixture
 *      `/v1/models`, enable a model, set it as org default → a brand-new
 *      session resolves to it and completes a turn via the resolution
 *      bridge's org key.
 *   3. Disable that provider → the existing session's next turn errors
 *      clearly; `PATCH /sessions/:id` recovers it; after the admin also
 *      repoints org preferences (the disabled model is no longer a valid
 *      preference — `PUT .../preferences` enforces this), new sessions fall
 *      back to the next entry in preference order.
 *   4. Non-admin members are 403'd off every settings route.
 *   5. No response body recorded anywhere in this test contains a stored key.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { fauxAssistantMessage, registerFauxProvider, type FauxProviderRegistration } from "@mariozechner/pi-ai";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { driveTurn } from "../integration/_test-utils.js";
import type {
  CreateLlmProviderResponse,
  CreateSessionResponse,
  GetLlmProviderPreferencesResponse,
  GetSessionResponse,
  ListLlmProvidersResponse,
  ProbeLlmProviderResponse,
  PutLlmProviderKeyResponse,
} from "../wire/types.js";

const HEADERS = { "Content-Type": "application/json" };
const MEMBER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };

/** Tiny `/v1/models`-shaped fixture server — pattern matches
 * `routes/llm-providers.test.ts`'s `startFakeModelsServer`. */
function startFakeModelsServer(models: { id: string }[]): { baseUrl: string; close(): Promise<void> } {
  const app = new Hono();
  app.get("/v1/models", (c) => c.json({ object: "list", data: models }));
  const server: ServerType = serve({ fetch: app.fetch, port: 0 });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("api e2e: llm providers exit criteria (fixture-backed, no network)", () => {
  let api: TestApi | undefined;
  let workspaceRoot: string | undefined;
  let anthropicFaux: FauxProviderRegistration | undefined;
  let customFaux: FauxProviderRegistration | undefined;
  let fakeModels: { baseUrl: string; close(): Promise<void> } | undefined;

  afterEach(async () => {
    anthropicFaux?.unregister();
    anthropicFaux = undefined;
    customFaux?.unregister();
    customFaux = undefined;
    await fakeModels?.close();
    fakeModels = undefined;
    await api?.cleanup();
    api = undefined;
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
    workspaceRoot = undefined;
    vi.unstubAllEnvs();
  });

  it(
    "org key over env, live rotation, custom-provider full loop, disable/recover, non-admin 403s, no key leakage",
    async () => {
      // Every response body this test touches, for the final no-leakage sweep.
      const bodies: string[] = [];
      async function j<T>(res: Response): Promise<T> {
        const text = await res.text();
        bodies.push(text);
        return text.length > 0 ? (JSON.parse(text) as T) : (undefined as T);
      }

      // Zero-config: only the deployment env var resolves Anthropic.
      vi.stubEnv("ANTHROPIC_API_KEY", "env-key");
      // Hijack real anthropic-messages calls; EngineHost's own model
      // resolution still resolves the real claude-haiku-4-5 Model object
      // (registry lookup), but the stream is intercepted here — same
      // pattern as channels/host.test.ts.
      anthropicFaux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
      const anthropicKeys: Array<string | undefined> = [];
      function nextAnthropicResponse() {
        anthropicFaux!.appendResponses([
          (_ctx, opts) => {
            anthropicKeys.push(opts?.apiKey);
            return fauxAssistantMessage("ok");
          },
        ]);
      }

      api = await bootTestApi();
      workspaceRoot = mkdtempSync(join(tmpdir(), "valet-llm-e2e-"));

      // ── 1. Zero-config: turn runs on the env key ────────────────────────
      const createRes = await fetch(`${api.baseUrl}/api/sessions`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ workspace: join(workspaceRoot, "s1") }),
      });
      expect(createRes.status).toBe(201);
      const { id: anthropicSessionId } = await j<CreateSessionResponse>(createRes);

      nextAnthropicResponse();
      await driveTurn({ baseUrl: api.baseUrl, wsUrl: api.wsUrl, sessionId: anthropicSessionId, prompt: "hi" });
      expect(anthropicKeys).toEqual(["env-key"]);

      // ── 2. Admin adds an org Anthropic key → the very next turn uses it,
      //      not env ──────────────────────────────────────────────────────
      const anthropicProviderRes = await fetch(`${api.baseUrl}/api/org/llm-providers`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ kind: "anthropic", name: "Anthropic" }),
      });
      expect(anthropicProviderRes.status).toBe(201);
      const anthropicProvider = await j<CreateLlmProviderResponse>(anthropicProviderRes);

      const orgKey1 = "org-anthropic-key-1";
      const putKey1Res = await fetch(`${api.baseUrl}/api/org/llm-providers/${anthropicProvider.id}/key`, {
        method: "PUT",
        headers: HEADERS,
        body: JSON.stringify({ apiKey: orgKey1 }),
      });
      expect(putKey1Res.status).toBe(200);
      const putKey1Body = await j<PutLlmProviderKeyResponse>(putKey1Res);
      expect(putKey1Body.keyLast4).toBe(orgKey1.slice(-4));

      nextAnthropicResponse();
      await driveTurn({ baseUrl: api.baseUrl, wsUrl: api.wsUrl, sessionId: anthropicSessionId, prompt: "hi again" });
      expect(anthropicKeys).toEqual(["env-key", orgKey1]);

      // ── 3. Rotate the key → next turn sees the new one, no reboot ──────
      const orgKey2 = "org-anthropic-key-2";
      const putKey2Res = await fetch(`${api.baseUrl}/api/org/llm-providers/${anthropicProvider.id}/key`, {
        method: "PUT",
        headers: HEADERS,
        body: JSON.stringify({ apiKey: orgKey2 }),
      });
      expect(putKey2Res.status).toBe(200);
      await j(putKey2Res);

      nextAnthropicResponse();
      await driveTurn({ baseUrl: api.baseUrl, wsUrl: api.wsUrl, sessionId: anthropicSessionId, prompt: "rotated?" });
      expect(anthropicKeys).toEqual(["env-key", orgKey1, orgKey2]);

      // ── 4. Custom (openai_compatible) provider: create, probe, enable,
      //      set default, new session resolves + completes a turn ────────
      fakeModels = startFakeModelsServer([{ id: "model-a" }, { id: "model-b" }]);
      const createCustomRes = await fetch(`${api.baseUrl}/api/org/llm-providers`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ kind: "openai_compatible", name: "Custom", baseUrl: fakeModels.baseUrl }),
      });
      expect(createCustomRes.status).toBe(201);
      const customProvider = await j<CreateLlmProviderResponse>(createCustomRes);

      const customKey = "org-custom-key";
      const putCustomKeyRes = await fetch(`${api.baseUrl}/api/org/llm-providers/${customProvider.id}/key`, {
        method: "PUT",
        headers: HEADERS,
        body: JSON.stringify({ apiKey: customKey }),
      });
      expect(putCustomKeyRes.status).toBe(200);
      await j(putCustomKeyRes);

      const probeRes = await fetch(`${api.baseUrl}/api/org/llm-providers/${customProvider.id}/probe`, {
        method: "POST",
        headers: HEADERS,
      });
      expect(probeRes.status).toBe(200);
      const probeBody = await j<ProbeLlmProviderResponse>(probeRes);
      expect(probeBody.models).toEqual([{ id: "model-a" }, { id: "model-b" }]);

      const enableModelRes = await fetch(`${api.baseUrl}/api/org/llm-providers/${customProvider.id}`, {
        method: "PATCH",
        headers: HEADERS,
        body: JSON.stringify({ models: [{ id: "model-a", name: "Model A" }] }),
      });
      expect(enableModelRes.status).toBe(200);
      await j(enableModelRes);

      const customSpec = `${customProvider.id}/model-a`;
      const setDefaultRes = await fetch(`${api.baseUrl}/api/org/llm-providers/preferences`, {
        method: "PUT",
        headers: HEADERS,
        body: JSON.stringify({ preferences: [customSpec] }),
      });
      expect(setDefaultRes.status).toBe(200);
      await j(setDefaultRes);

      customFaux = registerFauxProvider({ api: "openai-completions", provider: customProvider.id });
      const customKeys: Array<string | undefined> = [];
      customFaux.appendResponses([
        (_ctx, opts) => {
          customKeys.push(opts?.apiKey);
          return fauxAssistantMessage("ok");
        },
      ]);

      const createCustomSessionRes = await fetch(`${api.baseUrl}/api/sessions`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ workspace: join(workspaceRoot, "s2") }),
      });
      expect(createCustomSessionRes.status).toBe(201);
      const { id: customSessionId } = await j<CreateSessionResponse>(createCustomSessionRes);

      await driveTurn({ baseUrl: api.baseUrl, wsUrl: api.wsUrl, sessionId: customSessionId, prompt: "hi custom" });
      expect(customKeys).toEqual([customKey]);

      const customSessionDetailRes = await fetch(`${api.baseUrl}/api/sessions/${customSessionId}`);
      const customSessionDetail = await j<GetSessionResponse>(customSessionDetailRes);
      expect(customSessionDetail.model).toBe(customSpec);

      // ── 5. Disable the custom provider → the existing session's next turn
      //      errors clearly ───────────────────────────────────────────────
      const disableRes = await fetch(`${api.baseUrl}/api/org/llm-providers/${customProvider.id}`, {
        method: "PATCH",
        headers: HEADERS,
        body: JSON.stringify({ enabled: false }),
      });
      expect(disableRes.status).toBe(200);
      await j(disableRes);

      await expect(
        driveTurn({
          baseUrl: api.baseUrl,
          wsUrl: api.wsUrl,
          sessionId: customSessionId,
          prompt: "still there?",
          timeoutMs: 15_000,
        }),
      ).rejects.toThrow();

      // ── 6. PATCH .../model recovers the existing session ────────────────
      const patchModelRes = await fetch(`${api.baseUrl}/api/sessions/${customSessionId}`, {
        method: "PATCH",
        headers: HEADERS,
        body: JSON.stringify({ model: "claude-haiku-4-5" }),
      });
      expect(patchModelRes.status).toBe(200);
      const patched = await j<GetSessionResponse>(patchModelRes);
      expect(patched.model).toBe("claude-haiku-4-5");

      nextAnthropicResponse();
      await driveTurn({ baseUrl: api.baseUrl, wsUrl: api.wsUrl, sessionId: customSessionId, prompt: "recovered" });
      expect(anthropicKeys.at(-1)).toBe(orgKey2);

      // ── 7. New sessions fall back to preference order. The disabled
      //      model is no longer a valid preference (PUT .../preferences
      //      re-validates against the active catalog on every write) — the
      //      admin repoints preferences, and only then does a brand-new
      //      session pick up the fallback. ─────────────────────────────────
      const staleePrefsRes = await fetch(`${api.baseUrl}/api/org/llm-providers/preferences`, {
        method: "PUT",
        headers: HEADERS,
        body: JSON.stringify({ preferences: [customSpec] }),
      });
      expect(staleePrefsRes.status).toBe(400);
      await j(staleePrefsRes);

      const fixPrefsRes = await fetch(`${api.baseUrl}/api/org/llm-providers/preferences`, {
        method: "PUT",
        headers: HEADERS,
        body: JSON.stringify({ preferences: ["claude-haiku-4-5"] }),
      });
      expect(fixPrefsRes.status).toBe(200);
      const fixedPrefs = await j<GetLlmProviderPreferencesResponse>(fixPrefsRes);
      expect(fixedPrefs.preferences).toEqual(["claude-haiku-4-5"]);

      const createFallbackSessionRes = await fetch(`${api.baseUrl}/api/sessions`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ workspace: join(workspaceRoot, "s3") }),
      });
      expect(createFallbackSessionRes.status).toBe(201);
      const { id: fallbackSessionId } = await j<CreateSessionResponse>(createFallbackSessionRes);

      nextAnthropicResponse();
      await driveTurn({ baseUrl: api.baseUrl, wsUrl: api.wsUrl, sessionId: fallbackSessionId, prompt: "fallback?" });

      const fallbackDetailRes = await fetch(`${api.baseUrl}/api/sessions/${fallbackSessionId}`);
      const fallbackDetail = await j<GetSessionResponse>(fallbackDetailRes);
      expect(fallbackDetail.model).toBe("claude-haiku-4-5");

      // ── 8. Non-admin members are 403'd off the settings surface ────────
      const memberListRes = await fetch(`${api.baseUrl}/api/org/llm-providers`, { headers: MEMBER_HEADERS });
      expect(memberListRes.status).toBe(403);
      await j(memberListRes);

      const memberCreateRes = await fetch(`${api.baseUrl}/api/org/llm-providers`, {
        method: "POST",
        headers: MEMBER_HEADERS,
        body: JSON.stringify({ kind: "openai", name: "nope" }),
      });
      expect(memberCreateRes.status).toBe(403);
      await j(memberCreateRes);

      const memberPrefsRes = await fetch(`${api.baseUrl}/api/org/llm-providers/preferences`, {
        method: "PUT",
        headers: MEMBER_HEADERS,
        body: JSON.stringify({ preferences: [] }),
      });
      expect(memberPrefsRes.status).toBe(403);
      await j(memberPrefsRes);

      const listRes = await fetch(`${api.baseUrl}/api/org/llm-providers`, { headers: HEADERS });
      const listBody = await j<ListLlmProvidersResponse>(listRes);
      // Both providers had keys PUT above (steps 2 and 4) and neither key was
      // ever deleted, so both must still report `hasKey: true`.
      const anthropicSummary = listBody.providers.find((p) => p.id === anthropicProvider.id);
      const customSummary = listBody.providers.find((p) => p.id === customProvider.id);
      expect(anthropicSummary?.hasKey).toBe(true);
      expect(customSummary?.hasKey).toBe(true);

      // ── 9. Sweep: no response body recorded above contains a stored key.
      const allBodies = bodies.join("\n");
      for (const secret of [orgKey1, orgKey2, customKey]) {
        expect(allBodies).not.toContain(secret);
      }
    },
    60_000,
  );
});
