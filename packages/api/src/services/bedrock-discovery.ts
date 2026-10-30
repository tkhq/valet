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
 *
 * Ordered by tier. The first three are the frontier-class value picks
 * (2026-10-30, US-profile $/M in-out): DeepSeek V3.2 0.62/1.85, Mistral
 * Large 3 0.50/1.50, GLM-5.3 1.85/5.81 — far below Kimi K3's 3.30/16.50 for
 * similar benchmark standing. The rest are cheaper coding / utility models.
 */
export const BEDROCK_DEFAULT_MODEL_IDS: readonly string[] = [
  "deepseek.v3.2",
  "mistral.mistral-large-3-675b-instruct",
  "us.zai.glm-5.3",
  "qwen.qwen3-coder-next",
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
/** How long a failed lookup, or an inconclusive use-case answer, is held
 * before the account is asked again. Short enough that a fixed IAM policy
 * takes effect quickly, long enough that a broken one does not add three
 * AWS calls to every catalog build. */
const NEGATIVE_TTL_MS = 2 * 60 * 1000;

type Discovery = { models: LlmProviderModel[]; live: boolean };
type CacheEntry = { at: number; ttl: number; result: Discovery; warned: boolean };
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<Discovery>>();
const clients = new Map<string, BedrockDiscoveryClient>();

export function resetBedrockDiscoveryCache(): void {
  cache.clear();
  inflight.clear();
  clients.clear();
}

function clientFor(region: string): BedrockDiscoveryClient {
  let c = clients.get(region);
  if (!c) {
    // Discovery runs inside catalog builds that back /api/models and tier
    // validation, so a hung endpoint must fail fast, not stall the api.
    c = new BedrockClient({
      region,
      maxAttempts: 2,
      requestHandler: { requestTimeout: 3_000, connectionTimeout: 1_000 },
    });
    clients.set(region, c);
  }
  return c;
}

/** Every cross-region profile prefix Bedrock uses, so a bare id is told apart
 * from a profile id without guessing from the vendor segment. */
const GEO_PREFIXES = ["us.", "eu.", "apac.", "ca.", "sa.", "au.", "jp.", "in.", "global.", "us-gov."];

/** Registry entries plausible for this region: bare ids and this geo's
 * profiles, never `global.*`, and never Anthropic (its gate cannot be
 * checked when the account is unreachable, so it fails closed). */
function registryFallback(registry: Map<string, BedrockRegistryModel>, geoPrefix: string): LlmProviderModel[] {
  const out: LlmProviderModel[] = [];
  for (const m of registry.values()) {
    const geo = GEO_PREFIXES.find((g) => m.id.startsWith(g));
    if (geo && geo !== geoPrefix) continue;
    const bare = geo ? m.id.slice(geo.length) : m.id;
    if (bare.startsWith("anthropic.")) continue;
    out.push(toProviderModel(m));
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
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

type UseCaseAnswer = "allowed" | "no-form" | "unknown";

async function useCaseAnswer(client: BedrockDiscoveryClient): Promise<{ answer: UseCaseAnswer; error?: unknown }> {
  try {
    await client.send(new GetUseCaseForModelAccessCommand({}));
    return { answer: "allowed" };
  } catch (err) {
    const name = record(err) && typeof err.name === "string" ? err.name : "";
    return name === "ResourceNotFoundException" ? { answer: "no-form" } : { answer: "unknown", error: err };
  }
}

function warnOnce(entry: CacheEntry, message: string, error: unknown): void {
  if (entry.warned) return;
  entry.warned = true;
  console.warn(message, error instanceof Error ? error.message : error);
}

/**
 * Models the account can invoke, merged with registry metadata. Registry
 * entries win for name/context/pricing; ids the registry lacks keep Bedrock's
 * `modelName` and carry no pricing (resolution synthesizes them, decision 12).
 *
 * Caching: a successful lookup is held for an hour per region. A failed
 * lookup, or an inconclusive Anthropic use-case answer, is held for
 * NEGATIVE_TTL_MS and logged once. Concurrent misses share one lookup.
 */
export async function discoverBedrockModels(opts: {
  client?: BedrockDiscoveryClient;
  region?: string;
  now?: () => number;
} = {}): Promise<Discovery> {
  const region = opts.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
  const now = opts.now ?? Date.now;
  const hit = cache.get(region);
  if (hit && now() - hit.at < hit.ttl) return hit.result;
  const pending = inflight.get(region);
  if (pending) return pending;

  const run = (async (): Promise<Discovery> => {
    const registry = bedrockRegistry();
    const geoPrefix = geoPrefixForRegion(region);
    try {
      const client = opts.client ?? clientOverride ?? clientFor(region);
      const [modelSummaries, inferenceProfileSummaries, useCase] = await Promise.all([
        listAll<unknown>(client, (nextToken) => new ListFoundationModelsCommand({ byOutputModality: "TEXT", ...(nextToken ? { nextToken } : {}) }), "modelSummaries"),
        listAll<unknown>(client, (nextToken) => new ListInferenceProfilesCommand({ typeEquals: "SYSTEM_DEFINED", ...(nextToken ? { nextToken } : {}) }), "inferenceProfileSummaries"),
        useCaseAnswer(client),
      ]);
      const discovered = parseBedrockDiscovery({
        foundationModels: { modelSummaries },
        inferenceProfiles: { inferenceProfileSummaries },
        geoPrefix,
        // Anthropic is usable only once the account's use-case form is on
        // file. "no-form" is a firm no; "unknown" (denied, throttled) also
        // hides it, but only for the short window, and is logged.
        anthropicAllowed: useCase.answer === "allowed",
      });
      const models: LlmProviderModel[] = discovered.map((d) => {
        const reg = registry.get(d.id);
        return reg ? toProviderModel(reg) : { id: d.id, name: d.name };
      });
      models.sort((a, b) => a.id.localeCompare(b.id));
      const entry: CacheEntry = {
        at: now(),
        ttl: useCase.answer === "unknown" ? NEGATIVE_TTL_MS : CACHE_TTL_MS,
        result: { models, live: true },
        warned: false,
      };
      if (useCase.answer === "unknown") {
        warnOnce(entry, `bedrock discovery (${region}): GetUseCaseForModelAccess failed; hiding anthropic.* for ${NEGATIVE_TTL_MS / 1000}s:`, useCase.error);
      }
      cache.set(region, entry);
      return entry.result;
    } catch (err) {
      const entry: CacheEntry = {
        at: now(),
        ttl: NEGATIVE_TTL_MS,
        result: { models: registryFallback(registry, geoPrefix), live: false },
        warned: false,
      };
      warnOnce(entry, `bedrock discovery (${region}) failed; serving the bundled registry for ${NEGATIVE_TTL_MS / 1000}s:`, err);
      cache.set(region, entry);
      return entry.result;
    } finally {
      inflight.delete(region);
    }
  })();
  inflight.set(region, run);
  return run;
}
