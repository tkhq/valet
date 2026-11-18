import { encryptStringPBKDF2, decryptStringPBKDF2 } from '../lib/crypto.js';

/**
 * Result of the GitHub link OAuth exchange, carried from the callback to the
 * authenticated claim call. The callback persists nothing: it seals this
 * claim and hands it to the frontend, and only the user named in `userId`
 * can redeem it over their own authenticated session. This binds the link
 * to the user who started it, whoever ends up following the authorize URL.
 */
export interface GitHubLinkClaim {
  v: 1;
  userId: string;
  githubId: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  /** Unix seconds. */
  exp: number;
}

export const GITHUB_LINK_CLAIM_TTL_SECONDS = 300;

export type OpenClaimResult =
  | { ok: true; claim: GitHubLinkClaim }
  | { ok: false; status: 400 | 403; code: 'invalid_claim' | 'claim_expired' | 'user_mismatch' };

export function sealGitHubLinkClaim(claim: GitHubLinkClaim, key: string): Promise<string> {
  return encryptStringPBKDF2(JSON.stringify(claim), key);
}

function isClaim(value: unknown): value is GitHubLinkClaim {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    c.v === 1 &&
    typeof c.userId === 'string' &&
    typeof c.githubId === 'string' &&
    typeof c.login === 'string' &&
    typeof c.accessToken === 'string' &&
    typeof c.exp === 'number'
  );
}

/** Decrypts a sealed claim and checks it belongs to `userId` and has not expired. */
export async function openGitHubLinkClaim(
  blob: string,
  key: string,
  userId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<OpenClaimResult> {
  let parsed: unknown;
  try {
    // AES-GCM rejects tampered or foreign ciphertext, so a failure here means
    // the blob was not issued by this worker.
    parsed = JSON.parse(await decryptStringPBKDF2(blob, key));
  } catch {
    return { ok: false, status: 400, code: 'invalid_claim' };
  }
  if (!isClaim(parsed)) return { ok: false, status: 400, code: 'invalid_claim' };
  if (parsed.exp < nowSeconds) return { ok: false, status: 400, code: 'claim_expired' };
  if (parsed.userId !== userId) return { ok: false, status: 403, code: 'user_mismatch' };
  return { ok: true, claim: parsed };
}
