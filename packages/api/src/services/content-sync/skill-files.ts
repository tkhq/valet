import { createHash } from "node:crypto";
import type { SkillFile } from "@valet/engine";
import {
  type SkillRepoReader,
  type SkillRepoFile,
  type SkillTreeEntry,
} from "../skill-repo-reader.js";

export const MAX_SKILL_FILE_BYTES = 256 * 1024;
export const MAX_SKILL_FILES = 64;
export const MAX_SKILL_BYTES = 2 * 1024 * 1024;
export type SkillBlob = Pick<SkillRepoFile, "bytes" | "blobSha">;
export const SKILL_CAPS = `${MAX_SKILL_FILES}:${MAX_SKILL_FILE_BYTES}:${MAX_SKILL_BYTES}`;

/** Reject path aliases before they reach storage or the sandbox. */
export function validSkillPath(path: string): boolean {
  return path.length > 0 && !path.includes("\\") && !path.includes("\0") &&
    !/^[A-Za-z]:/.test(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** Index each regular blob under its nearest regular SKILL.md boundary.
 * Each tree entry is visited twice, independent of the number of skills. */
export function indexCompanions(tree: SkillTreeEntry[]): Map<string, SkillTreeEntry[]> {
  const directories = new Set<string>();
  const regular = (entry: SkillTreeEntry) => entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755");
  for (const entry of tree) {
    if (regular(entry) && entry.path.endsWith("/SKILL.md")) directories.add(entry.path.slice(0, -"/SKILL.md".length));
  }
  const groups = new Map<string, SkillTreeEntry[]>();
  for (const entry of tree) {
    if (!regular(entry) || entry.path.endsWith("/SKILL.md")) continue;
    let directory = entry.path.slice(0, entry.path.lastIndexOf("/"));
    while (directory) {
      if (directories.has(directory)) {
        const relative = entry.path.slice(directory.length + 1);
        if (validSkillPath(relative)) {
          const key = `${directory}/SKILL.md`;
          const files = groups.get(key) ?? [];
          files.push(entry);
          groups.set(key, files);
        }
        break;
      }
      const slash = directory.lastIndexOf("/");
      directory = slash < 0 ? "" : directory.slice(0, slash);
    }
  }
  for (const files of groups.values()) files.sort((a, b) => a.path.localeCompare(b.path));
  return groups;
}

export function skillWithFilesSha(body: string, files: SkillFile[]): string {
  const hash = createHash("sha256").update(body, "utf8");
  if (files.length > 0) {
    hash.update("\0").update(JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path))
      .map((file) => [file.path, file.blobSha, file.mode])));
  }
  return hash.digest("hex");
}

export async function readSkillFiles(
  reader: SkillRepoReader,
  repo: string,
  ref: string,
  skillPath: string,
  entries: SkillTreeEntry[],
  previous: SkillFile[],
  reads: Map<string, SkillBlob | null>,
): Promise<{ files: SkillFile[]; warning?: string; deferred?: boolean }> {
  const files: SkillFile[] = [];
  const cached = new Map(previous.map((file) => [`${file.path}:${file.blobSha}`, file]));
  const prefix = skillPath.slice(0, -"SKILL.md".length);
  let total = 0;
  const skipped: string[] = [];
  let skippedCount = 0;
  let deferred = false;
  const rejected = new Set<string>();
  const warnCap = (path: string) => {
    if (rejected.has(path)) return;
    rejected.add(path); skippedCount++;
    if (skipped.length < 10) skipped.push(path);
  };
  const keep = (file: SkillFile) => {
    if (files.length >= MAX_SKILL_FILES || file.size > MAX_SKILL_FILE_BYTES || total + file.size > MAX_SKILL_BYTES) {
      warnCap(`${prefix}${file.path}`);
      return;
    }
    total += file.size;
    files.push(file);
  };
  for (const entry of entries) {
    const old = cached.get(`${entry.path.slice(prefix.length)}:${entry.sha}`);
    const size = entry.size ?? old?.size ?? 0;
    if (files.length >= MAX_SKILL_FILES || size > MAX_SKILL_FILE_BYTES || total + size > MAX_SKILL_BYTES) {
      warnCap(entry.path);
      continue;
    }
    let read = old ? null : reads.get(entry.sha);
    if (read === undefined && !deferred) {
      try {
        read = await reader.readFile(repo, entry.path, ref);
        reads.set(entry.sha, read ? { bytes: read.bytes, blobSha: read.blobSha } : null);
      } catch {
        // Rate limits, the shared read budget, and deadlines defer companions,
        // never the body or successful reads from this pass.
        deferred = true;
      }
    }
    if (!old && (!read?.bytes || read.blobSha !== entry.sha)) {
      deferred = true;
      const stored = previous.find(file => file.path === entry.path.slice(prefix.length));
      if (stored) keep(stored);
      continue;
    }
    const bytes = read?.bytes;
    const actualSize = old?.size ?? bytes!.byteLength;
    if (actualSize > MAX_SKILL_FILE_BYTES || total + actualSize > MAX_SKILL_BYTES) {
      warnCap(entry.path);
      continue;
    }
    keep({ path: entry.path.slice(prefix.length), blobSha: entry.sha, size: actualSize, mode: entry.mode,
      ...(bytes ? { bytes } : {}) });
  }
  if (deferred) {
    const kept = new Set(files.map(file => file.path));
    for (const file of previous) if (!kept.has(file.path)) keep(file);
  }
  const warnings: string[] = [];
  if (skippedCount) warnings.push(`${skipped.join(", ")}${skippedCount > 10 ? ` and ${skippedCount - 10} more` : ""} exceed companion caps (${SKILL_CAPS}). Reduce these files to import them.`);
  if (deferred) warnings.push("Companion reads were deferred. Saved the body and available files. Sync again to retry remaining files.");
  return { files, deferred, ...(warnings.length ? { warning: warnings.join(" ") } : {}) };
}
