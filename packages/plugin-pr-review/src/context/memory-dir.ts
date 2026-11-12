/**
 * Team memory from a local directory of Markdown files, for the eval and
 * the CLI. It stands in for the plugin host's memory port: `search` ranks
 * files by how many query words their path, title, description and body
 * hold, `read` returns a file by its memory path, and `list` returns the
 * files under a path prefix.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { PackMemory } from "./gather.js";

interface MemoryFile {
  path: string;
  title: string;
  description: string;
  content: string;
  haystack: string;
}

/**
 * `root` holds memory files; `mount` is the memory path they appear under
 * (a content source's `.valet/memory` mounts at `lib`, so pass `lib`).
 */
export function directoryMemory(root: string, mount = ""): PackMemory {
  let files: MemoryFile[] | undefined;
  const load = (): MemoryFile[] => {
    if (files) return files;
    const found: MemoryFile[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name.startsWith(".")) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".md")) {
          const content = readFileSync(full, "utf8");
          const field = (key: string): string => new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, "m").exec(content.slice(0, 2000))?.[1] ?? "";
          const path = [mount, relative(root, full)].filter(Boolean).join("/");
          const title = field("title") || name.replace(/\.md$/, "");
          const description = field("description");
          found.push({ path, title, description, content, haystack: `${path} ${title} ${description} ${content.slice(0, 4000)}`.toLowerCase() });
        }
      }
    };
    walk(root);
    files = found;
    return found;
  };
  return {
    async search(query, opts) {
      const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
      if (words.length === 0) return [];
      return load()
        .map((f) => ({ f, score: words.filter((w) => f.haystack.includes(w)).length }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || a.f.path.localeCompare(b.f.path))
        .slice(0, opts?.limit ?? 10)
        .map(({ f }) => ({ path: f.path, title: f.title, description: f.description, snippet: f.content.replace(/^---[\s\S]*?---\n?/, "").slice(0, 200) }));
    },
    async list(prefix, opts) {
      return load()
        .filter((f) => f.path.startsWith(prefix))
        .sort((a, b) => a.path.localeCompare(b.path))
        .slice(0, opts?.limit ?? 200)
        .map((f) => ({ path: f.path, title: f.title, description: f.description }));
    },
    async read(path) {
      const f = load().find((x) => x.path === path);
      return f ? { path: f.path, content: f.content } : null;
    },
  };
}
