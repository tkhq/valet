import type { CredentialStore, StoredCredential } from "@valet/engine";
import type { AppQueryable } from "../lib/drizzle.js";
import {
  resolveTeamCredentialRead,
  resolveUserCredentialRead,
  type OrgFallback,
} from "./credential-resolution.js";
import { listLlmProviders } from "./llm-providers.js";
import type { OnePasswordService, OnePasswordScope } from "./onepassword.js";

/**
 * Resolve the OpenAI API key for the `"openai"` credential service — the
 * probe `plugin-openai`'s `requiresCredential` gating and its actions both
 * read. Precedence:
 *
 *   1. The org's enabled OpenAI LLM-provider key (`llm:{rowId}`, the same
 *      credential model resolution uses for `openai/*` chat models).
 *   2. A stored `"openai"` row for the session owner: a team owner reads
 *      the team row (`resolveTeamCredentialRead`) under `ctx.orgFallback`,
 *      the policy the caller reads from the plugin declarations
 *      (`orgFallbackPolicy`), so a team session reaches the same org-scoped
 *      1Password item a team workflow reaches; a user owner reads via
 *      `resolveUserCredentialRead`. A team or org owner never reads the
 *      prompting member's user row.
 *   3. The host's `OPENAI_API_KEY` env var.
 *
 * `null` means "not configured": the plugin catalog hides the openai tools.
 */
export async function resolveOpenAiCredential(
  db: AppQueryable,
  credentials: CredentialStore,
  ctx: {
    orgId: string;
    userId?: string;
    owner?: { type: string; id: string };
    scopes: readonly OnePasswordScope[];
    /** Org fallback for the team read. Defaults to `"reference-only"`,
     * what `orgFallbackPolicy` yields for a service that declares no org
     * credential, which `openai` does not. */
    orgFallback?: OrgFallback;
  },
  env: Record<string, string | undefined> = process.env,
  onePassword?: OnePasswordService,
): Promise<StoredCredential | null> {
  const rows = await listLlmProviders(db, ctx.orgId);
  const row = rows.find((r) => r.kind === "openai" && r.enabled);
  if (row) {
    const stored = await credentials.get({ type: "org", id: ctx.orgId }, `llm:${row.id}`);
    const key = stored?.apiKey?.trim();
    if (key) return { type: "api_key", apiKey: key };
  }
  const ownerType = ctx.owner?.type;
  if (ownerType === "team" && ctx.owner) {
    const team = await resolveTeamCredentialRead(
      { credentials, onePassword },
      { orgId: ctx.orgId, teamId: ctx.owner.id, userId: ctx.userId, scopes: ctx.scopes },
      "openai",
      ctx.orgFallback ?? "reference-only",
    );
    if (team) return team;
  } else if (ownerType !== "org" && ctx.userId) {
    const direct = await resolveUserCredentialRead(
      { credentials, onePassword },
      { orgId: ctx.orgId, userId: ctx.userId, scopes: ctx.scopes },
      "openai",
      // The org LLM-provider key above is the org-wide path for this service;
      // a plain org `openai` row is not a second one. A reference still passes.
      "reference-only",
    );
    if (direct) return direct;
  }
  const envKey = env.OPENAI_API_KEY?.trim();
  return envKey ? { type: "api_key", apiKey: envKey } : null;
}
