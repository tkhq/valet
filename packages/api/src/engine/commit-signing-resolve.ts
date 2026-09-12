/**
 * Decides whether a session gets the `turnkey-session-key` prep step, and
 * supplies the I/O that step needs (agent commit signing design).
 *
 * The step exists when the deployment has `VALET_TURNKEY_*` set and the
 * session's user has an enrollment row in the plugin store. Everything else
 * degrades to "no commit signing": a session starts as before, and
 * `valet-sign` names the fix if a commit is signed.
 */
import { loadTurnkeyConfig, type TurnkeyDeploymentConfig } from "@valet/plugin-turnkey/config";
import {
  COLLECTIONS,
  DEFAULT_KEY,
  PLUGIN_NAME,
  type EnrollmentDoc,
  type SessionKeyDoc,
} from "@valet/plugin-turnkey/store";
import { turnkeyOps, type TurnkeyOpsFactory } from "@valet/plugin-turnkey/turnkey-client";
import type { AppDb } from "../lib/drizzle.js";
import { pluginStore } from "../services/plugin-store.js";
import type { CommitSigningSnapshot } from "./sandbox-spec.js";

/** Session API keys outlive any single signing window; 24 h matches the window cap. */
export const SESSION_KEY_TTL_SECONDS = 24 * 60 * 60;

export interface CommitSigningResolveDeps {
  config?: TurnkeyDeploymentConfig | null;
  turnkey?: TurnkeyOpsFactory;
  now?: () => number;
}

export async function resolveCommitSigning(
  db: AppDb,
  meta: { userId: string; sessionId: string },
  deps: CommitSigningResolveDeps = {},
): Promise<CommitSigningSnapshot | undefined> {
  let config: TurnkeyDeploymentConfig | null;
  try {
    config = deps.config === undefined ? loadTurnkeyConfig(process.env) : deps.config;
  } catch (err) {
    console.error("commit signing: deployment config is invalid; sessions start unsigned:", err instanceof Error ? err.message : err);
    return undefined;
  }
  if (!config) return undefined;
  const sessionId = meta.sessionId;

  const store = pluginStore(db, PLUGIN_NAME);
  const enrollment = await store.user(meta.userId).get<EnrollmentDoc>(COLLECTIONS.enrollment, DEFAULT_KEY);
  if (!enrollment) return undefined;
  const { subOrgId, agentUserId } = enrollment.doc;
  const resolvedConfig = config;
  const makeOps = deps.turnkey ?? turnkeyOps;
  const now = deps.now ?? (() => Date.now());

  return {
    subOrgId,
    agentUserId,
    apiBaseUrl: resolvedConfig.apiBaseUrl,
    async issueSessionKey(publicKey) {
      const createdAt = now();
      const { apiKeyId } = await makeOps(resolvedConfig).createApiKey({
        subOrgId,
        userId: agentUserId,
        name: `session:${sessionId}`,
        publicKey,
        expirationSeconds: SESSION_KEY_TTL_SECONDS,
      });
      const expiresAt = createdAt + SESSION_KEY_TTL_SECONDS * 1000;
      const doc: SessionKeyDoc = { apiKeyId, publicKey, createdAt, expiresAt };
      await store.session(sessionId).put(COLLECTIONS.sessionKey, DEFAULT_KEY, doc);
      return { expiresAt };
    },
  };
}
