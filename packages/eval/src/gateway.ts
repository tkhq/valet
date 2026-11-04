/**
 * Route eval model calls through a Valet LLM gateway (`/proxy/*`) with a
 * `vlt_` Valet key, so runs bill the organization's provider credential and
 * show up in Valet usage instead of using a personal provider key.
 *
 * Set `VALET_LLM_GATEWAY_URL` (the Valet host, e.g.
 * https://valet.dev.agents.turnkey.engineering) and either `VALET_API_KEY`
 * or `VALET_API_KEY_FILE`. See docs/specs/2026-08-26-llm-proxy-mitm-design.md.
 */
import { readFileSync } from "node:fs";
import { resolveModelId, type Model } from "@valet/engine";

export interface LlmGateway {
  /** Valet host, without a trailing slash. */
  url: string;
  /** A `vlt_` key. */
  apiKey: string;
}

export function llmGatewayFromEnv(env: NodeJS.ProcessEnv = process.env): LlmGateway | undefined {
  const url = env.VALET_LLM_GATEWAY_URL?.trim();
  if (!url) return undefined;
  const apiKey = env.VALET_API_KEY?.trim() || (env.VALET_API_KEY_FILE ? readFileSync(env.VALET_API_KEY_FILE, "utf8").trim() : "");
  if (!apiKey.startsWith("vlt_")) {
    throw new Error(
      "VALET_LLM_GATEWAY_URL is set but no vlt_ key was found. Set VALET_API_KEY or VALET_API_KEY_FILE to a Valet API key from Settings.",
    );
  }
  return { url: url.replace(/\/+$/, ""), apiKey };
}

/** The same model, sent to the gateway's wire-compatible mount for its provider. */
export function viaGateway(model: Model<string>, gateway: LlmGateway): Model<string> {
  if (model.provider === "anthropic") return { ...model, baseUrl: `${gateway.url}/proxy/anthropic` };
  if (model.provider === "openai") return { ...model, baseUrl: `${gateway.url}/proxy/openai/v1` };
  throw new Error(`The Valet gateway has no route for provider ${model.provider}. Use an anthropic or openai model.`);
}

/** Session `resolveModel` seam: every turn, the turn model and the Valet key. */
export function gatewayModelResolver(
  gateway: LlmGateway,
): (spec: string) => Promise<{ model: Model<string>; apiKey: string } | null> {
  return async (spec) => {
    const model = resolveModelId(spec);
    return model ? { model: viaGateway(model, gateway), apiKey: gateway.apiKey } : null;
  };
}
