import { createHash } from "node:crypto";
import { credentialSecret, type StoredCredential } from "@valet/engine";
import { verifySlackBotToken, type SlackWorkspaceIdentity } from "./slack-connect.js";

interface IdentityInput {
  orgId: string;
  accessToken: string;
  teamId: string;
  botUserId?: string;
}

interface CachedIdentity {
  expiresAt: number;
  result: Promise<SlackWorkspaceIdentity | undefined>;
}

// One small map per credential-store instance, keyed by the hashed input.
// The Slack inbox drain reads the raw credential and the event matchers read
// the 1Password-resolved one, so their entries must not evict each other.
// The weak key isolates API instances without retaining disposed stores.
const identities = new WeakMap<object, Map<string, CachedIdentity>>();
const SUCCESS_TTL_MS = 10 * 60_000;
const FAILURE_TTL_MS = 60_000;
/** Inputs per store: an org has one Slack credential, read at most two ways. */
const MAX_ENTRIES = 8;

/** Legacy installations predate botId metadata. Resolve their identity from
 * the saved token, without rewriting credentials or racing a reconnect. */
export function resolveSlackBotIdentity(cacheOwner: object, input: IdentityInput): Promise<SlackWorkspaceIdentity | undefined> {
  const key = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  let cache = identities.get(cacheOwner);
  if (!cache) {
    cache = new Map();
    identities.set(cacheOwner, cache);
  }
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const result = verifySlackBotToken(input.accessToken).then((check) =>
    check.ok && check.identity.teamId === input.teamId
      && (!input.botUserId || check.identity.botUserId === input.botUserId)
      ? check.identity : undefined,
    () => undefined,
  ).then((identity) => {
    entry.expiresAt = Date.now() + (identity ? SUCCESS_TTL_MS : FAILURE_TTL_MS);
    return identity;
  });
  // Share pending lookups. auth.test has a bounded timeout; expiry starts
  // when it settles so a slow failure cannot cause a burst of retries.
  const entry: CachedIdentity = { expiresAt: Infinity, result };
  cache.delete(key);
  cache.set(key, entry);
  // A changed token leaves its old entry behind. Drop the oldest entries.
  for (const old of cache.keys()) {
    if (cache.size <= MAX_ENTRIES) break;
    cache.delete(old);
  }
  return result;
}

/**
 * The Slack bot user id of an org's Slack credential. It is the stored
 * `botUserId` metadata, or, for a legacy installation without it, the id
 * that `resolveSlackBotIdentity` verifies from the saved token. The Slack
 * inbox drain gives this id to the follow router, and the event matchers
 * read it too, so the router, claim resolution, and the dispatcher agree on
 * which posts address the bot. `cacheOwner` is the credential store.
 */
export async function slackBotUserIdOf(
  cacheOwner: object,
  orgId: string,
  credential: StoredCredential | null | undefined,
): Promise<string | undefined> {
  const stored = credential?.metadata?.botUserId;
  if (typeof stored === "string" && stored !== "") return stored;
  const accessToken = credentialSecret(credential);
  const teamId = credential?.metadata?.teamId;
  if (!accessToken || typeof teamId !== "string" || teamId === "") return undefined;
  return (await resolveSlackBotIdentity(cacheOwner, { orgId, accessToken, teamId }))?.botUserId;
}
