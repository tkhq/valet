import { splitModelRef } from '@valet/shared';
import type { Env } from '../env.js';
import { getDb } from '../lib/drizzle.js';
import { getOrgSettings } from '../lib/db/org.js';
import { getUserById } from '../lib/db/users.js';
import { parseModelId } from '../lib/llm/model-id.js';
import { assembleLlmProviderEnv } from '../lib/llm/provider-env.js';

export async function resolveWorkflowOutputRepairModel(params: {
  env: Env;
  userId: string;
  explicitModel?: string;
}): Promise<string | undefined> {
  if (params.explicitModel) return normalizeWorkflowModelId(params.explicitModel);

  // Preferences hold catalog ids from the model picker, which can name any
  // connected OpenCode provider — but repair runs on the worker-side AI SDK,
  // which only supports its whitelisted providers. Take the first preference
  // the repair pipeline can actually run instead of failing at repair time.
  const db = getDb(params.env.DB);
  const user = await getUserById(db, params.userId);
  const userModel = firstRunnableModel(user?.modelPreferences);
  if (userModel) return userModel;

  const org = await getOrgSettings(db);
  return firstRunnableModel(org.modelPreferences);
}

function firstRunnableModel(preferences: string[] | null | undefined): string | undefined {
  for (const candidate of preferences ?? []) {
    const normalized = normalizeWorkflowModelId(candidate);
    try {
      parseModelId(normalized);
      return normalized;
    } catch {
      // not runnable by the AI SDK — try the next preference
    }
  }
  return undefined;
}

export async function assembleWorkflowOutputRepairEnv(env: Env): Promise<Env> {
  const providerEnv = await assembleLlmProviderEnv(getDb(env.DB), env);
  return { ...env, ...providerEnv };
}

export function normalizeWorkflowModelId(modelId: string): string {
  const ref = splitModelRef(modelId);
  return ref ? `${ref.provider}:${ref.model}` : modelId.trim();
}
