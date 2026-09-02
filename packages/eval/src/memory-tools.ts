/**
 * In-memory `mem_*` tools for eval sessions (TKAI-329).
 *
 * Production `mem_*` tools (packages/api/src/orchestrator/memory-tools.ts)
 * call the memory HTTP routes, which need a running API server. Evals wrap
 * the engine in-process with no server, so cases that exercise memory
 * behavior (tool selection, write-then-read sequencing) run against this
 * Map-backed stand-in instead. Tool names and the path-based surface match
 * production so `tool_called` checks transfer; storage semantics
 * (rendering, dedup, link graph) deliberately do not.
 */
import { Type } from "typebox";
import type { ToolDef } from "@valet/engine";

interface MemoryFile {
  content: string;
  description?: string;
}

/** One memory store per eval case run. */
export class EvalMemoryStore {
  readonly files = new Map<string, MemoryFile>();
}

export function buildEvalMemoryTools(store: EvalMemoryStore): ToolDef[] {
  const memWrite: ToolDef = {
    name: "mem_write",
    description:
      "Create or update a memory file. Search with mem_search before writing to update an existing file about the same thing instead of creating a duplicate.",
    parameters: Type.Object({
      path: Type.String({ description: "Memory path, e.g. 'notes/deploy-freeze.md'." }),
      content: Type.String({ description: "Full body content (markdown)." }),
      description: Type.Optional(Type.String({ description: "One-line summary used in search results." })),
    }),
    execute: async (args) => {
      const { path, content, description } = args as { path: string; content: string; description?: string };
      const existed = store.files.has(path);
      store.files.set(path, { content, ...(description !== undefined ? { description } : {}) });
      return { text: `${existed ? "Updated" : "Created"}: ${path}` };
    },
  };

  const memRead: ToolDef = {
    name: "mem_read",
    description:
      "Read a memory file (returns its content) or a directory (returns a listing). Pass a path ending in '/' or '' for the root to read a directory.",
    parameters: Type.Object({
      path: Type.String({ description: "File path, or a directory path (trailing '/', or '' for the root)." }),
    }),
    execute: async (args) => {
      const { path } = args as { path: string };
      if (path === "" || path.endsWith("/")) {
        const listing = [...store.files.keys()]
          .filter((p) => p.startsWith(path))
          .sort()
          .join("\n");
        return { text: listing.length > 0 ? listing : "(empty)" };
      }
      const file = store.files.get(path);
      if (!file) return { text: `Not found: ${path}` };
      return { text: file.content };
    },
  };

  const memSearch: ToolDef = {
    name: "mem_search",
    description: "Search memory files by substring over path, description, and content.",
    parameters: Type.Object({
      query: Type.String({ description: "Search text." }),
    }),
    execute: async (args) => {
      const { query } = args as { query: string };
      const q = query.toLowerCase();
      const hits = [...store.files.entries()]
        .filter(
          ([path, f]) =>
            path.toLowerCase().includes(q) ||
            f.content.toLowerCase().includes(q) ||
            (f.description?.toLowerCase().includes(q) ?? false),
        )
        .map(([path, f]) => `${path}${f.description ? ` — ${f.description}` : ""}`);
      return { text: hits.length > 0 ? hits.join("\n") : "No results." };
    },
  };

  const memRm: ToolDef = {
    name: "mem_rm",
    description: "Delete a memory file.",
    parameters: Type.Object({
      path: Type.String({ description: "File path to delete." }),
    }),
    execute: async (args) => {
      const { path } = args as { path: string };
      const existed = store.files.delete(path);
      return { text: existed ? `Deleted: ${path}` : `Not found: ${path}` };
    },
  };

  return [memWrite, memRead, memSearch, memRm];
}
