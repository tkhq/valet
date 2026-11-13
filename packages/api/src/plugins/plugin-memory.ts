/**
 * `PluginMemory` for a plugin handler: the owner's memory through the memory
 * service. A plugin reads what a task needs and puts it into a child's
 * prompt. It writes only under the directories its manifest declares in
 * `memoryWrites`, through the same service checks as an agent write.
 */
import type { PluginMemory, Principal } from "@valet/engine";
import { NotFoundError } from "@valet/shared";
import type { AppDb } from "../lib/drizzle.js";
import { listFiles, readFile, searchFiles, writeFile, type MemoryScope } from "../services/memory.js";

/** Search results a plugin gets at most, whatever it asks for. */
const MAX_SEARCH_RESULTS = 20;
/** Listed files a plugin gets at most, whatever it asks for. */
const MAX_LIST_RESULTS = 200;
/** The virtual prefix of a file in a team's or org's memory. */
const OWNER_PREFIX = /^(team|org):[^/]+\//;

/** The error a plugin gets for a write outside its declared directories. */
export class PluginMemoryWriteError extends Error {
  constructor(plugin: string, path: string, writable: readonly string[]) {
    super(
      writable.length === 0
        ? `Plugin ${plugin} cannot write memory. Declare the directory in the plugin manifest's memoryWrites.`
        : `Plugin ${plugin} cannot write ${path}. It may write only under ${writable.join(", ")}.`,
    );
    this.name = "PluginMemoryWriteError";
  }
}

export function buildPluginMemory(
  db: AppDb,
  owner: Principal,
  actorUserId: string,
  orgId: string,
  plugin: { name: string; memoryWrites?: readonly string[] } = { name: "unknown" },
): PluginMemory {
  const writable = (plugin.memoryWrites ?? []).filter((d) => d.endsWith("/") && !d.startsWith("lib/"));
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
    async write(path, file) {
      // A declared directory, never `lib/`, and no traversal out of it: the memory service normalizes the rest.
      if (path.includes("..") || path.startsWith("lib/") || !writable.some((d) => path.startsWith(d))) {
        throw new PluginMemoryWriteError(plugin.name, path, writable);
      }
      await writeFile(db, scope, { path, content: file.content, description: file.description, origin: `plugin:${plugin.name}` });
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
