/**
 * Amazon Bedrock model discovery (bedrock-provider design, extension
 * 2026-10-30, decisions 9–10).
 *
 * pi-ai's `amazon-bedrock` registry lists ~185 models across every vendor and
 * region prefix. What an AWS account can actually invoke is narrower and
 * account-specific: some models need a cross-region inference profile, some
 * are gated behind a one-time vendor form (Anthropic), and availability
 * differs by region. This module asks the account instead of guessing:
 *
 *   ListFoundationModels (text output) → candidate models
 *   ListInferenceProfiles (SYSTEM_DEFINED) → profile ids for profile-only models
 *   GetUseCaseForModelAccess → whether anthropic.* is usable at all
 *
 * The result is merged with the registry for name/context/pricing and cached
 * in-process for an hour per region. It mirrors `services/openrouter.ts`:
 * any failure degrades to the registry list with `live: false`, so the
 * picker still works and the UI can say the account lookup failed.
 */
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import {
  BedrockClient,
  GetUseCaseForModelAccessCommand,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
} from "@aws-sdk/client-bedrock";
import type { LlmProviderModel } from "../schema/index.js";
import { registryModels } from "./model-registry.js";

/**
 * Zero-config default selection: open-weight models verified invokable in
 * agents-dev on 2026-10-29 and present in pi-ai's registry. Seeded onto a
 * new amazon-bedrock row and used as the no-row catalog (filtered by live
 * discovery when available). No Anthropic (account form gate) and no
 * `global.*` (routes to any commercial region).
 */
export const BEDROCK_DEFAULT_MODEL_IDS: readonly string[] = [
  "qwen.qwen3-coder-next",
  "deepseek.v3.2",
  "mistral.devstral-2-123b",
  "moonshotai.kimi-k2.5",
  "openai.gpt-oss-120b-1:0",
  "us.meta.llama4-maverick-17b-instruct-v1:0",
  "zai.glm-4.7",
  "minimax.minimax-m2.5",
];

export type BedrockRegistryModel = Model<Api>;

export function bedrockRegistry(): Map<string, BedrockRegistryModel> {
  return new Map(registryModels("amazon-bedrock").map((m) => [m.id, m]));
}

function toProviderModel(m: BedrockRegistryModel): LlmProviderModel {
  return {
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow,
    pricing: { input: m.cost.input, output: m.cost.output },
  };
}

/** The default selection as row-ready entries; ids the registry lacks are dropped. */
export function curatedBedrockModels(): LlmProviderModel[] {
  const registry = bedrockRegistry();
  const out: LlmProviderModel[] = [];
  for (const id of BEDROCK_DEFAULT_MODEL_IDS) {
    const m = registry.get(id);
    if (m) out.push(toProviderModel(m));
  }
  return out;
}

/** Bedrock's cross-region profile prefix for the pod's region. */
export function geoPrefixForRegion(region: string): string {
  const geo = region.split("-")[0];
  switch (geo) {
    case "us":
      return "us.";
    case "eu":
      return "eu.";
    case "ap":
      return "apac.";
    case "ca":
      return "ca.";
    case "sa":
      return "sa.";
    default:
      return "us.";
  }
}

/** The subset of the AWS client this module uses; tests inject a fake. */
export type BedrockDiscoveryClient = { send(cmd: unknown): Promise<unknown> };

function record(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Pure derivation of invokable ids. An ON_DEMAND model is invoked by its bare
 * id. A profile-only model is invoked by the SYSTEM_DEFINED profile in this
 * geography whose `models[]` names it; a model with no such profile is
 * omitted rather than listed under an id Bedrock would reject. `global.*`
 * profiles are never derived.
 */
export function parseBedrockDiscovery(input: {
  foundationModels: unknown;
  inferenceProfiles: unknown;
  geoPrefix: string;
  anthropicAllowed: boolean;
}): { id: string; name: string }[] {
  // modelId → geo profile id, from the profile list.
  const profileFor = new Map<string, string>();
  const summaries = record(input.inferenceProfiles) ? input.inferenceProfiles.inferenceProfileSummaries : undefined;
  if (Array.isArray(summaries)) {
    for (const p of summaries) {
      if (!record(p) || typeof p.inferenceProfileId !== "string") continue;
      if (!p.inferenceProfileId.startsWith(input.geoPrefix)) continue;
      if (p.status !== undefined && p.status !== "ACTIVE") continue;
      const models = Array.isArray(p.models) ? p.models : [];
      for (const m of models) {
        const arn = record(m) && typeof m.modelArn === "string" ? m.modelArn : undefined;
        const modelId = arn?.split("/").pop();
        if (modelId && !profileFor.has(modelId)) profileFor.set(modelId, p.inferenceProfileId);
      }
    }
  }

  const out: { id: string; name: string }[] = [];
  const models = record(input.foundationModels) ? input.foundationModels.modelSummaries : undefined;
  if (!Array.isArray(models)) return out;
  for (const m of models) {
    if (!record(m) || typeof m.modelId !== "string") continue;
    const lifecycle = record(m.modelLifecycle) ? m.modelLifecycle.status : undefined;
    if (lifecycle !== undefined && lifecycle !== "ACTIVE") continue;
    if (!strings(m.outputModalities).includes("TEXT")) continue;
    if (!strings(m.inputModalities).includes("TEXT")) continue;
    if (m.responseStreamingSupported === false) continue;
    if (!input.anthropicAllowed && m.modelId.startsWith("anthropic.")) continue;
    const types = strings(m.inferenceTypesSupported);
    const name = typeof m.modelName === "string" && m.modelName ? m.modelName : m.modelId;
    if (types.includes("ON_DEMAND")) {
      out.push({ id: m.modelId, name });
      continue;
    }
    if (types.includes("INFERENCE_PROFILE")) {
      const profile = profileFor.get(m.modelId);
      if (profile) out.push({ id: profile, name });
    }
  }
  return out;
}

/** Test seam: a client used in place of the real one when no `client` option
 * is passed. Lets route and catalog tests drive discovery without AWS. */
let clientOverride: BedrockDiscoveryClient | undefined;
export function setBedrockDiscoveryClientForTests(client: BedrockDiscoveryClient | undefined): void {
  clientOverride = client;
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; result: { models: LlmProviderModel[]; live: true } }>();

export function resetBedrockDiscoveryCache(): void {
  cache.clear();
}

async function listAll<T>(client: BedrockDiscoveryClient, make: (nextToken?: string) => unknown, key: string): Promise<T[]> {
  const items: T[] = [];
  let nextToken: string | undefined;
  do {
    const page = await client.send(make(nextToken));
    if (!record(page)) break;
    const arr = page[key];
    if (Array.isArray(arr)) items.push(...(arr as T[]));
    nextToken = typeof page.nextToken === "string" ? page.nextToken : undefined;
  } while (nextToken);
  return items;
}

/**
 * Models the account can invoke, merged with registry metadata. Registry
 * entries win for name/context/pricing; ids the registry lacks keep Bedrock's
 * `modelName` and carry no pricing (resolution synthesizes them, decision 12).
 */
export async function discoverBedrockModels(opts: {
  client?: BedrockDiscoveryClient;
  region?: string;
  now?: () => number;
} = {}): Promise<{ models: LlmProviderModel[]; live: boolean }> {
  const region = opts.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
  const now = opts.now ?? Date.now;
  const hit = cache.get(region);
  if (hit && now() - hit.at < CACHE_TTL_MS) return hit.result;

  const registry = bedrockRegistry();
  try {
    const client = opts.client ?? clientOverride ?? new BedrockClient({ region });
    const [modelSummaries, inferenceProfileSummaries, anthropicAllowed] = await Promise.all([
      listAll<unknown>(client, (nextToken) => new ListFoundationModelsCommand({ byOutputModality: "TEXT", ...(nextToken ? { nextToken } : {}) }), "modelSummaries"),
      listAll<unknown>(client, (nextToken) => new ListInferenceProfilesCommand({ typeEquals: "SYSTEM_DEFINED", ...(nextToken ? { nextToken } : {}) }), "inferenceProfileSummaries"),
      // Anthropic models are usable only once the account's use-case form is
      // on file. Any failure here hides them: a missing form is a
      // ResourceNotFoundException, and we would rather hide than list models
      // that fail on first use.
      client.send(new GetUseCaseForModelAccessCommand({})).then(() => true, () => false),
    ]);
    const discovered = parseBedrockDiscovery({
      foundationModels: { modelSummaries },
      inferenceProfiles: { inferenceProfileSummaries },
      geoPrefix: geoPrefixForRegion(region),
      anthropicAllowed,
    });
    const models: LlmProviderModel[] = discovered.map((d) => {
      const reg = registry.get(d.id);
      return reg ? toProviderModel(reg) : { id: d.id, name: d.name };
    });
    models.sort((a, b) => a.id.localeCompare(b.id));
    const result = { models, live: true as const };
    cache.set(region, { at: now(), result });
    return result;
  } catch {
    const models = Array.from(registry.values()).map(toProviderModel);
    models.sort((a, b) => a.id.localeCompare(b.id));
    return { models, live: false };
  }
}
