/**
 * Sync user data between local and cloud Valet.
 *
 * Syncs (bidirectional, user-owned):
 * - memories/ (OKF markdown files)
 * - personas/
 * - skills/ (user-created only)
 * - workflows/ (user-owned only)
 * - preferences.json
 *
 * Caches (read-only, expires):
 * - org-skills/
 * - org-workflows/
 *
 * Never syncs:
 * - credentials (accessed via cloud proxy)
 * - team config
 */

import { promises as fs } from "fs";
import * as path from "path";
import { homedir } from "os";

export function getValetDir(): string {
  return path.join(homedir(), ".valet");
}

export function getSyncDir(): string {
  return path.join(getValetDir(), "sync");
}

export function getCacheDir(): string {
  return path.join(getValetDir(), "cache");
}

export function getAuthPath(): string {
  return path.join(getValetDir(), "auth.json");
}

export interface SyncOptions {
  pull?: boolean;  // Pull from cloud only
  push?: boolean;  // Push to cloud only
  only?: string[]; // Selective sync: ["memories", "skills", ...]
}

export interface AuthToken {
  sessionToken: string;
  expiresAt: number;
  userId: string;
}

/**
 * Check if user is logged in
 */
export async function isLoggedIn(): Promise<boolean> {
  try {
    const authPath = getAuthPath();
    await fs.access(authPath);
    const auth = JSON.parse(await fs.readFile(authPath, "utf-8")) as AuthToken;
    return auth.expiresAt > Date.now();
  } catch {
    return false;
  }
}

/**
 * Get the current auth token
 */
export async function getAuthToken(): Promise<AuthToken | null> {
  try {
    const authPath = getAuthPath();
    const auth = JSON.parse(await fs.readFile(authPath, "utf-8")) as AuthToken;
    if (auth.expiresAt < Date.now()) {
      return null;
    }
    return auth;
  } catch {
    return null;
  }
}

/**
 * Save auth token after login
 */
export async function saveAuthToken(token: AuthToken): Promise<void> {
  const valetDir = getValetDir();
  await fs.mkdir(valetDir, { recursive: true });
  await fs.writeFile(getAuthPath(), JSON.stringify(token, null, 2));
}

/**
 * Clear auth token on logout
 */
export async function clearAuth(): Promise<void> {
  try {
    await fs.unlink(getAuthPath());
  } catch {
    // Already cleared
  }
}

/**
 * Sync data with cloud
 */
export async function sync(options: SyncOptions = {}): Promise<void> {
  const auth = await getAuthToken();
  if (!auth) {
    throw new Error("Not logged in. Run: valet login");
  }

  const syncDir = getSyncDir();
  const cacheDir = getCacheDir();
  await fs.mkdir(syncDir, { recursive: true });
  await fs.mkdir(cacheDir, { recursive: true });

  const categories = options.only || ["memories", "personas", "skills", "workflows", "preferences"];

  console.log("🔄 Syncing with Valet cloud...\n");

  // TODO: Implement actual cloud sync API calls
  // For now, just create the directory structure

  for (const category of categories) {
    const categoryDir = path.join(syncDir, category);
    await fs.mkdir(categoryDir, { recursive: true });

    if (!options.push) {
      console.log(`  ↓ Pulling ${category}...`);
      // TODO: GET /api/v1/sync/{category}
    }

    if (!options.pull) {
      console.log(`  ↑ Pushing ${category}...`);
      // TODO: POST /api/v1/sync/{category}
    }
  }

  // Cache org data (read-only)
  if (!options.push && !options.only) {
    console.log("  ↓ Caching org skills...");
    await fs.mkdir(path.join(cacheDir, "org-skills"), { recursive: true });

    console.log("  ↓ Caching org workflows...");
    await fs.mkdir(path.join(cacheDir, "org-workflows"), { recursive: true });

    // Write cache metadata
    await fs.writeFile(
      path.join(cacheDir, ".cache-meta.json"),
      JSON.stringify({ lastSync: Date.now(), ttl: 24 * 60 * 60 * 1000 })
    );
  }

  console.log("\n✓ Sync complete");
}
