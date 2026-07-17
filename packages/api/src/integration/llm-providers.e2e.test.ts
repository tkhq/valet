/**
 * LLM providers — live e2e (llm-providers design doc "Exit criteria" /
 * "Testing" sections; plan Task 9 step 2). One real OpenAI turn, driven
 * entirely through an org-stored key (not the `OPENAI_API_KEY` env
 * fallback): the deployment env var is used only to seed the org credential,
 * then unset for the duration of the turn to prove the resolution bridge
 * (`services/model-resolution.ts`) is reading the org credential and not
 * silently falling back to env.
 *
 * Key-gated (`describeIfKey`, matching every other suite in this
 * directory): skips cleanly when `OPENAI_API_KEY` isn't set in the shell, so
 * CI without the key still passes.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootTestApi, type TestApi } from "./_setup.js";
import { driveTurn } from "./_test-utils.js";
import type { CreateLlmProviderResponse, CreateSessionResponse, ListMessagesResponse } from "../wire/types.js";

const describeIfKey = process.env.OPENAI_API_KEY ? describe : describe.skip;

const HEADERS = { "Content-Type": "application/json" };

describeIfKey("api integration: llm providers — one real OpenAI turn through an org key", () => {
  let api: TestApi | undefined;
  let workspaceRoot: string | undefined;
  let realOpenAiKey: string | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
    workspaceRoot = undefined;
    if (realOpenAiKey !== undefined) {
      process.env.OPENAI_API_KEY = realOpenAiKey;
      realOpenAiKey = undefined;
    }
  });

  it(
    "org-stored OpenAI key (env var unset for the turn) completes a real turn",
    async () => {
      realOpenAiKey = process.env.OPENAI_API_KEY;
      if (!realOpenAiKey) throw new Error("unreachable: describeIfKey gated on OPENAI_API_KEY");

      api = await bootTestApi();
      workspaceRoot = mkdtempSync(join(tmpdir(), "valet-llm-openai-e2e-"));

      // Seed the org credential from the real key, THEN unset the env var —
      // any turn that still succeeds proves the org credential path, not
      // pi-ai's env fallback.
      const createProviderRes = await fetch(`${api.baseUrl}/api/org/llm-providers`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ kind: "openai", name: "OpenAI" }),
      });
      expect(createProviderRes.status).toBe(201);
      const openaiProvider = (await createProviderRes.json()) as CreateLlmProviderResponse;

      const putKeyRes = await fetch(`${api.baseUrl}/api/org/llm-providers/${openaiProvider.id}/key`, {
        method: "PUT",
        headers: HEADERS,
        body: JSON.stringify({ apiKey: realOpenAiKey }),
      });
      expect(putKeyRes.status).toBe(200);

      // Prove the org-key path, not env fallback.
      delete process.env.OPENAI_API_KEY;

      const createSessionRes = await fetch(`${api.baseUrl}/api/sessions`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ workspace: workspaceRoot }),
      });
      expect(createSessionRes.status).toBe(201);
      const { id: sessionId } = (await createSessionRes.json()) as CreateSessionResponse;

      const patchModelRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: HEADERS,
        body: JSON.stringify({ model: "openai/gpt-4o-mini" }),
      });
      expect(patchModelRes.status).toBe(200);

      await driveTurn({
        baseUrl: api.baseUrl,
        wsUrl: api.wsUrl,
        sessionId,
        prompt: "Reply with exactly the single word: pong",
      });

      const msgRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/messages`);
      expect(msgRes.status).toBe(200);
      const { messages } = (await msgRes.json()) as ListMessagesResponse;
      const assistantText = messages
        .filter((m) => m.role === "assistant")
        .flatMap((m) => m.parts)
        .filter((p): p is { kind: "text"; text: string } => p.kind === "text")
        .map((p) => p.text)
        .join(" ");
      expect(assistantText.length).toBeGreaterThan(0);
    },
    60_000,
  );
});
