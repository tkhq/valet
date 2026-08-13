/**
 * Host-side providers for the slash-command subsystem (slash-commands plan,
 * Task 10). These adapt app data (Drizzle, the org model catalog, child-session
 * links) into the engine's injection contracts:
 *
 *  - `makeTemplateProvider` — `TemplateProvider`, merging the user's saved
 *    prompt templates (Drizzle `user_prompt_templates`) with repo templates
 *    read from the session's sandbox (`/workspace/.valet/prompts/*.md`).
 *  - `makeCommandContext` — `CommandContext`, backing `/model` (the org model
 *    catalog) and `/sessions` (this session's children).
 *
 * The engine owns the registry and dispatch; these only supply data it cannot
 * reach on its own.
 */
import { desc, eq } from "drizzle-orm";
import type {
  CommandContext,
  PromptTemplate,
  Sandbox,
  TemplateProvider,
} from "@valet/engine";
import type { CredentialStore } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions, childWatches, userPromptTemplates } from "../schema/index.js";
import { buildOrgCatalog } from "../services/model-catalog.js";

/** Where repo templates live inside a prepared workspace. */
const REPO_PROMPTS_GLOB = "/workspace/.valet/prompts/*.md";

/** Delimiter the repo-template exec prints before each file's content. */
const TMPL_DELIM = "===VALET-TMPL ";

/**
 * One exec that dumps every `/workspace/.valet/prompts/*.md` file, each
 * preceded by a `===VALET-TMPL <path>` line. `readRepoTemplates` parses the
 * combined stdout on that delimiter. A single exec (not one per file) keeps the
 * round-trip count fixed regardless of how many templates a repo carries.
 */
const REPO_TEMPLATE_EXEC = `sh -c 'for f in ${REPO_PROMPTS_GLOB}; do [ -f "$f" ] || continue; printf "${TMPL_DELIM}%s\\n" "$f"; cat "$f"; done'`;

/**
 * Reads repo prompt templates from a prepared sandbox. Returns `[]` when:
 *  - no sandbox is available (the accessor returned `undefined` — e.g. the
 *    attachment is not `ready`, so listing must not provision one), or
 *  - the exec exits non-zero (no matching files, or the shell is unavailable).
 *
 * `name` is the filename without its `.md` suffix. `description` is read from a
 * leading `description:` frontmatter line when present.
 */
export async function readRepoTemplates(sandbox: Sandbox | undefined): Promise<PromptTemplate[]> {
  if (!sandbox) return [];
  let stdout: string;
  try {
    const result = await sandbox.exec(REPO_TEMPLATE_EXEC);
    if (result.exitCode !== 0) return [];
    stdout = result.stdout;
  } catch {
    // A sandbox that rejects the exec (transient provisioning race, unusual
    // shell) yields no repo templates rather than failing the whole listing.
    return [];
  }
  return parseRepoTemplates(stdout);
}

/** Parses the delimited stdout of `REPO_TEMPLATE_EXEC` into templates. */
function parseRepoTemplates(stdout: string): PromptTemplate[] {
  const templates: PromptTemplate[] = [];
  // Split on the delimiter; the first chunk is whatever preceded the first
  // marker (empty for well-formed output) and is skipped.
  const chunks = stdout.split(TMPL_DELIM);
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    const newlineIdx = chunk.indexOf("\n");
    if (newlineIdx === -1) continue;
    const path = chunk.slice(0, newlineIdx).trim();
    const content = chunk.slice(newlineIdx + 1);
    const base = path.slice(path.lastIndexOf("/") + 1);
    const name = base.endsWith(".md") ? base.slice(0, -3) : base;
    if (!name) continue;
    templates.push({
      name,
      description: readFrontmatterDescription(content),
      content,
      origin: "repo",
    });
  }
  return templates;
}

/**
 * Extracts a `description:` value from a leading frontmatter block. Supports
 * both a fenced `---` block and a bare leading `description:` line, so a
 * minimally-tagged template still gets a description.
 */
function readFrontmatterDescription(content: string): string | undefined {
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed === "---") continue;
    const match = trimmed.match(/^description:\s*(.+)$/i);
    if (match) return match[1].trim().replace(/^["']|["']$/g, "");
    // Stop at the first non-frontmatter, non-empty line.
    if (!trimmed.includes(":")) break;
  }
  return undefined;
}

/**
 * Builds the `TemplateProvider` for a session. Repo templates come first so a
 * user template of the same name shadows the repo one (registry precedence:
 * the later entry wins on a name collision).
 *
 * `sandbox()` resolves the session's sandbox handle lazily and returns
 * `undefined` when no prepared sandbox is available — the host guards it so a
 * `GET /commands` call never provisions a sandbox just to list templates.
 */
export function makeTemplateProvider(
  db: AppDb,
  userId: string,
  sandbox: () => Sandbox | undefined,
): TemplateProvider {
  return {
    async listTemplates(): Promise<PromptTemplate[]> {
      const rows = await db
        .select()
        .from(userPromptTemplates)
        .where(eq(userPromptTemplates.userId, userId));
      const user: PromptTemplate[] = rows.map((r) => ({
        name: r.name,
        description: r.description ?? undefined,
        content: r.content,
        origin: "user" as const,
      }));
      const repo = await readRepoTemplates(sandbox());
      return [...repo, ...user];
    },
  };
}

/**
 * Builds the `CommandContext` for a session.
 *
 * `listModels` reuses `buildOrgCatalog` — the same enumeration `GET /api/models`
 * serves — filtered to the picker-visible (active) set, mapped to `{ id, name }`.
 *
 * `listChildSessions` joins `child_watches` to `agent_sessions` for this
 * session's children (the same source `GET /api/orchestrator/children` reads),
 * newest first. `status` is `"settled"` or `"running"`, mirroring that route.
 */
export function makeCommandContext(
  db: AppDb,
  credentials: CredentialStore,
  orgId: string,
  sessionId: string,
): CommandContext {
  return {
    async listModels(): Promise<Array<{ id: string; name: string }>> {
      const entries = await buildOrgCatalog(db, credentials, orgId);
      return entries.filter((e) => e.active).map((e) => ({ id: e.id, name: e.name }));
    },
    async listChildSessions(): Promise<Array<{ id: string; title?: string; status: string }>> {
      const rows = await db
        .select({
          childSessionId: childWatches.childSessionId,
          settled: childWatches.settled,
          title: agentSessions.title,
        })
        .from(childWatches)
        .innerJoin(agentSessions, eq(agentSessions.id, childWatches.childSessionId))
        .where(eq(childWatches.parentSessionId, sessionId))
        .orderBy(desc(childWatches.createdAt));
      return rows.map((r) => ({
        id: r.childSessionId,
        title: r.title ?? undefined,
        status: r.settled ? "settled" : "running",
      }));
    },
  };
}
