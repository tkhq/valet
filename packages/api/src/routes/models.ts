/**
 * `/api/models` — pi-ai's static Anthropic model registry (split-settings
 * design, decision 9). No provider API call; the registry is bundled with
 * pi-ai and read once at module load. Anthropic-only for now, matching
 * `EngineHost.resolveModel`.
 */
import { Hono } from "hono";
import { getModels } from "@mariozechner/pi-ai";
import type { AppEnv } from "../env.js";
import type { ListModelsResponse, ModelInfo } from "../wire/types.js";

export const modelsRouter = new Hono<AppEnv>();

const MODELS: ModelInfo[] = getModels("anthropic").map((m) => ({
  id: m.id,
  name: m.name,
  contextWindow: m.contextWindow,
  reasoning: m.reasoning,
}));

modelsRouter.get("/", (c) => {
  const resp: ListModelsResponse = { models: MODELS };
  return c.json(resp);
});
