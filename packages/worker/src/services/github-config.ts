import type { AppDb } from '../lib/drizzle.js';
import type { Env } from '../env.js';
import { getServiceConfig, getServiceMetadata } from '../lib/db/service-configs.js';

export interface GitHubServiceConfig {
  appId: string;
  appPrivateKey: string;
  appSlug: string;
  appWebhookSecret: string;
  appOauthClientId: string;
  appOauthClientSecret: string;
}

export interface GitHubServiceMetadata {
  appOwner?: string;
  appOwnerType?: string;
  appName?: string;
  allowPersonalInstallations?: boolean;
  allowAnonymousGitHubAccess?: boolean;
  // AI code review — ORG policy. Precedence (org ceiling; owner may only loosen)
  // is defined + enforced in resolveCodeReviewGate (webhooks.ts).
  codeReviewEnabled?: boolean;     // master switch (default true; OFF is absolute)
  codeReviewEnforced?: boolean;    // lock the per-user knobs (default false)
  codeReviewMentionOnly?: boolean; // org-wide mention-only (default false)
}

export interface GitHubConfig {
  appId: string;
  appPrivateKey: string;
  appSlug: string;
  appWebhookSecret: string;
  appOauthClientId: string;
  appOauthClientSecret: string;
}

/**
 * Resolve GitHub config from D1.
 * Returns null if the GitHub App is not configured.
 */
export async function getGitHubConfig(env: Env, db: AppDb): Promise<GitHubConfig | null> {
  try {
    const svc = await getServiceConfig<GitHubServiceConfig, GitHubServiceMetadata>(
      db, env.ENCRYPTION_KEY, 'github',
    );
    if (!svc || !svc.config.appId || !svc.config.appOauthClientId) return null;
    return {
      appId: svc.config.appId,
      appPrivateKey: svc.config.appPrivateKey,
      appSlug: svc.config.appSlug,
      appWebhookSecret: svc.config.appWebhookSecret,
      appOauthClientId: svc.config.appOauthClientId,
      appOauthClientSecret: svc.config.appOauthClientSecret,
    };
  } catch {
    return null;
  }
}

/**
 * Get just the GitHub metadata without decrypting secrets.
 */
export async function getGitHubMetadata(db: AppDb): Promise<GitHubServiceMetadata | null> {
  try {
    return await getServiceMetadata<GitHubServiceMetadata>(db, 'github');
  } catch {
    return null;
  }
}
