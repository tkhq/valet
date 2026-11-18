/**
 * The detectors the secret-intake eval compares: today's backstop and
 * composer rules, stage 1 at a score threshold, and stage 1 plus a model
 * confirmation (stage 2).
 */
import {
  INTAKE_SYSTEM_PROMPT,
  buildIntakePrompt,
  detectSecrets,
  findSecretCandidates,
  parseIntakeVerdicts,
} from "@valet/shared";
import { readFileSync } from "node:fs";
import type { LabeledMessage } from "./dataset.js";
import type { Span } from "./metrics.js";

export type Detector = (m: LabeledMessage) => Promise<Span[]>;

export const backstopToday: Detector = async (m) =>
  detectSecrets(m.text).filter((c) => c.confidence === "known");

export const composerToday: Detector = async (m) => detectSecrets(m.text);

export function stage1(threshold: number): Detector {
  return async (m) =>
    findSecretCandidates(m.text, m.credentialRequested ? { credentialRequested: true } : {}).filter(
      (c) => c.score >= threshold,
    );
}

export interface ModelEndpoint {
  url: string;
  headers: Record<string, string>;
  model: string;
}

/** Anthropic Messages endpoint: the Valet gateway when set, else the provider. */
export function modelEndpointFromEnv(env: NodeJS.ProcessEnv = process.env): ModelEndpoint | undefined {
  const model = env.SECRET_INTAKE_MODEL?.trim() || "claude-haiku-5-5";
  const gateway = env.VALET_LLM_GATEWAY_URL?.trim().replace(/\/+$/, "");
  const vlt = env.VALET_API_KEY?.trim() || (env.VALET_API_KEY_FILE ? readFileSync(env.VALET_API_KEY_FILE, "utf8").trim() : "");
  const base = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
  if (gateway && vlt?.startsWith("vlt_")) {
    const access = env.VALET_GATEWAY_ACCESS_TOKEN?.trim();
    return {
      url: `${gateway}/proxy/anthropic/v1/messages`,
      headers: { ...base, "x-api-key": vlt, ...(access ? { "cf-access-token": access } : {}) },
      model,
    };
  }
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (key) return { url: "https://api.anthropic.com/v1/messages", headers: { ...base, "x-api-key": key }, model };
  return undefined;
}

/**
 * Stage 1 at `threshold`, then one model call per message to confirm. With
 * `keepAbove`, candidates at or above that score skip the model.
 */
export function stage2(endpoint: ModelEndpoint, threshold = 0.2, keepAbove = Number.POSITIVE_INFINITY): Detector {
  return async (m) => {
    const candidates = findSecretCandidates(m.text, m.credentialRequested ? { credentialRequested: true } : {}).filter(
      (c) => c.score >= threshold,
    );
    // Known formats and strong stage-1 candidates are kept without a model:
    // the model may only add candidates stage 1 scored low, never veto.
    const known = candidates.filter((c) => c.reason === "known" || c.score >= keepAbove);
    const ask = candidates.filter((c) => !known.includes(c));
    if (ask.length === 0) return known;
    const user = buildIntakePrompt(m.text, ask, m.credentialRequested === true);
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: endpoint.headers,
      body: JSON.stringify({ model: endpoint.model, max_tokens: 400, system: INTAKE_SYSTEM_PROMPT, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error(`model call failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const verdicts = parseIntakeVerdicts(body.content?.find((b) => b.type === "text")?.text ?? "", ask.length);
    // A missing verdict keeps the candidate: a miss leaks a key.
    const kept = ask.filter((_, i) => verdicts[i]?.secret !== false);
    return [...known, ...kept];
  };
}
