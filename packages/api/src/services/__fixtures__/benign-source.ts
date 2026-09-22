/**
 * A fixed block of TypeScript-looking text for tripwire tests.
 *
 * The tripwire must not block ordinary source output. Tests need a realistic
 * atom to feed it, and reading a real repo file at test time would make the
 * test depend on unrelated edits. This constant is the stand-in: plain
 * source text, about 7 KB, with no credential-shaped strings in it.
 */
export const BENIGN_SOURCE = `import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface CatalogEntry {
  id: string;
  name: string;
  version: string;
  createdAt: number;
  updatedAt: number;
  tags: string[];
}

export interface CatalogPage {
  entries: CatalogEntry[];
  cursor: string | null;
  total: number;
}

export interface CatalogOptions {
  root: string;
  pageSize: number;
  includeArchived: boolean;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;
const CATALOG_FILE = "catalog.json";

// Token shapes most likely to collide with a credential window: hex
// constants, hash digests, and a short base64 blob.
const MAGIC_HEADER = 0x89504e47;
const ROUTING_MASK = 0xfeedfacecafebeef;
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const SEED_DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ICON_BLOB =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SIGNING_ALGORITHMS = ["hs256", "rs256", "es256", "eddsa"] as const;

export function isKnownDigest(value: string): boolean {
  return value === EMPTY_TREE_SHA || value === SEED_DIGEST;
}

export function iconBytes(): string {
  return ICON_BLOB;
}

export function headerMatches(word: number): boolean {
  return (word & MAGIC_HEADER) !== 0 || (word & Number(ROUTING_MASK & 0xffffffffn)) !== 0;
}

export function isSigningAlgorithm(name: string): boolean {
  return SIGNING_ALGORITHMS.some((algorithm) => algorithm === name.toLowerCase());
}

export function normalizeName(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

export function fingerprint(entry: CatalogEntry): string {
  const hash = createHash("sha256");
  hash.update(entry.id);
  hash.update(entry.name);
  hash.update(entry.version);
  return hash.digest("hex").slice(0, 16);
}

export function sortEntries(entries: CatalogEntry[]): CatalogEntry[] {
  return [...entries].sort((left, right) => {
    if (left.name !== right.name) return left.name.localeCompare(right.name);
    return left.version.localeCompare(right.version);
  });
}

export function filterByTag(entries: CatalogEntry[], tag: string): CatalogEntry[] {
  const wanted = normalizeName(tag);
  return entries.filter((entry) => entry.tags.some((t) => normalizeName(t) === wanted));
}

export function clampPageSize(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isFinite(requested)) return DEFAULT_PAGE_SIZE;
  if (requested < 1) return 1;
  if (requested > MAX_PAGE_SIZE) return MAX_PAGE_SIZE;
  return Math.floor(requested);
}

export function paginate(entries: CatalogEntry[], cursor: string | null, size: number): CatalogPage {
  const ordered = sortEntries(entries);
  const start = cursor ? ordered.findIndex((entry) => entry.id === cursor) + 1 : 0;
  const slice = ordered.slice(start, start + size);
  const last = slice.at(-1);
  return {
    entries: slice,
    cursor: start + size < ordered.length && last ? last.id : null,
    total: ordered.length,
  };
}

export class CatalogStore {
  private readonly root: string;
  private readonly pageSize: number;
  private readonly includeArchived: boolean;
  private cache: Map<string, CatalogEntry> | null = null;

  constructor(options: CatalogOptions) {
    this.root = resolve(options.root);
    this.pageSize = clampPageSize(options.pageSize);
    this.includeArchived = options.includeArchived;
  }

  private path(): string {
    return join(this.root, CATALOG_FILE);
  }

  async load(): Promise<Map<string, CatalogEntry>> {
    if (this.cache) return this.cache;
    const raw = await readFile(this.path(), "utf8").catch(() => "[]");
    const parsed: unknown = JSON.parse(raw);
    const next = new Map<string, CatalogEntry>();
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        const id = record.id;
        const name = record.name;
        if (typeof id !== "string" || typeof name !== "string") continue;
        next.set(id, {
          id,
          name,
          version: typeof record.version === "string" ? record.version : "0.0.0",
          createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
          updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
          tags: Array.isArray(record.tags) ? record.tags.filter((t) => typeof t === "string") : [],
        });
      }
    }
    this.cache = next;
    return next;
  }

  async save(entries: Map<string, CatalogEntry>): Promise<void> {
    const payload = JSON.stringify([...entries.values()], null, 2);
    await writeFile(this.path(), payload, "utf8");
    this.cache = entries;
  }

  async list(cursor: string | null): Promise<CatalogPage> {
    const entries = await this.load();
    const visible = [...entries.values()].filter((entry) => {
      if (this.includeArchived) return true;
      return !entry.tags.includes("archived");
    });
    return paginate(visible, cursor, this.pageSize);
  }

  async get(id: string): Promise<CatalogEntry | null> {
    const entries = await this.load();
    return entries.get(id) ?? null;
  }

  async put(entry: CatalogEntry): Promise<CatalogEntry> {
    const entries = await this.load();
    const now = Date.now();
    const existing = entries.get(entry.id);
    const merged: CatalogEntry = {
      ...entry,
      name: normalizeName(entry.name),
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };
    entries.set(merged.id, merged);
    await this.save(entries);
    return merged;
  }

  async remove(id: string): Promise<boolean> {
    const entries = await this.load();
    if (!entries.delete(id)) return false;
    await this.save(entries);
    return true;
  }

  async rebuild(): Promise<number> {
    const entries = await this.load();
    let touched = 0;
    for (const entry of entries.values()) {
      const next = normalizeName(entry.name);
      if (next === entry.name) continue;
      entries.set(entry.id, { ...entry, name: next, updatedAt: Date.now() });
      touched += 1;
    }
    if (touched > 0) await this.save(entries);
    return touched;
  }
}

export interface DiffResult {
  added: string[];
  removed: string[];
  changed: string[];
}

export function diffCatalogs(before: CatalogEntry[], after: CatalogEntry[]): DiffResult {
  const beforeById = new Map(before.map((entry) => [entry.id, entry]));
  const afterById = new Map(after.map((entry) => [entry.id, entry]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [id, entry] of afterById) {
    const prior = beforeById.get(id);
    if (!prior) {
      added.push(id);
      continue;
    }
    if (fingerprint(prior) !== fingerprint(entry)) changed.push(id);
  }
  for (const id of beforeById.keys()) {
    if (!afterById.has(id)) removed.push(id);
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

export function summarize(diff: DiffResult): string {
  const parts: string[] = [];
  if (diff.added.length > 0) parts.push(\`added \${diff.added.length}\`);
  if (diff.removed.length > 0) parts.push(\`removed \${diff.removed.length}\`);
  if (diff.changed.length > 0) parts.push(\`changed \${diff.changed.length}\`);
  return parts.length > 0 ? parts.join(", ") : "no changes";
}

export function assertValidVersion(version: string): void {
  const parts = version.split(".");
  if (parts.length !== 3) throw new Error(\`version must have three parts: \${version}\`);
  for (const part of parts) {
    if (!/^[0-9]+$/.test(part)) throw new Error(\`version part must be numeric: \${part}\`);
  }
}

export function bumpVersion(version: string, level: "major" | "minor" | "patch"): string {
  assertValidVersion(version);
  const [major, minor, patch] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (level === "major") return \`\${major + 1}.0.0\`;
  if (level === "minor") return \`\${major}.\${minor + 1}.0\`;
  return \`\${major}.\${minor}.\${patch + 1}\`;
}
`;
