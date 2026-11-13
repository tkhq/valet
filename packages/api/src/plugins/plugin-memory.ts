/**
 * `PluginMemory` for a plugin handler: read-only access to the owner's
 * memory through the memory service. A plugin reads what a task needs and
 * puts it into a child's prompt; it never writes memory.
 */
import type { PluginMemory, Principal } from "@valet/engine";
import { NotFoundError } from "@valet/shared";
import type { AppDb } from "../lib/drizzle.js";
import { listFiles, readFile, searchFiles, type MemoryScope } from "../services/memory.js";

/** Search results a plugin gets at most, whatever it asks for. */
const MAX_SEARCH_RESULTS = 20;
/** Listed files a plugin gets at most, whatever it asks for. */
const MAX_LIST_RESULTS = 200;
/** The virtual prefix of a file in a team's or org's memory. */
const OWNER_PREFIX = /^(team|org):[^/]+\//;

export function buildPluginMemory(db: AppDb, owner: Principal, actorUserId: string, orgId: string): PluginMemory {
  // No namespace: the owner's shared memory, which a team's members all read.
  // `orgId` keeps a person's line from reading their other orgs' memory.
  const scope: MemoryScope = { owner, actorUserId, orgId };
  return {
    async search(query, opts) {
      const limit = Math.min(Math.max(1, opts?.limit ?? 10), MAX_SEARCH_RESULTS);
      const results = await searchFiles(db, scope, { query, limit });
      return results.map((r) => ({
        path: r.path,
        title: r.title,
        description: r.description,
        snippet: r.snippet.map((s) => s.text).join(""),
      }));
    },
    async list(prefix, opts) {
      const limit = Math.min(Math.max(1, opts?.limit ?? MAX_LIST_RESULTS), MAX_LIST_RESULTS);
      // The same read-union as `search` and `read`: the owner, its teams and its org, within `orgId`.
      const files = await listFiles(db, scope);
      return files
        .filter((f) => f.path.startsWith(prefix) || f.path.replace(OWNER_PREFIX, "").startsWith(prefix))
        .slice(0, limit)
        .map((f) => ({ path: f.path, title: f.title, description: f.description }));
    },
    async read(path) {
      try {
        const result = await readFile(db, scope, path);
        return result.kind === "file" ? { path: result.path, content: result.rendered } : null;
      } catch (err) {
        if (err instanceof NotFoundError) return null;
        throw err;
      }
    },
  };
}
