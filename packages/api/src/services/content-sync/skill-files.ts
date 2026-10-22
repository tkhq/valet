import { createHash } from "node:crypto";
import type { SkillFile } from "@valet/engine";
import type { SkillCandidate } from "../skill-discovery.js";
import {
  type SkillRepoReader,
  type SkillTreeEntry,
} from "../skill-repo-reader.js";

export const MAX_SKILL_FILE_BYTES = 256 * 1024;
export const MAX_SKILL_BYTES = 2 * 1024 * 1024;

/** Reject path aliases before they reach storage or the sandbox. */
export function validSkillPath(path: string): boolean {
  return path.length > 0 && !path.includes("\\") && !path.includes("\0") &&
    !/^[A-Za-z]:/.test(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** A nested SKILL.md makes its whole directory belong to another skill. */
export function companionEntries(candidate: SkillCandidate, tree: SkillTreeEntry[]): SkillTreeEntry[] {
  if (candidate.kind !== "skill") return [];
  const prefix = candidate.path.slice(0, -"SKILL.md".length);
  const nested = tree.filter((entry) => entry.path.startsWith(prefix) &&
    entry.path !== candidate.path && entry.path.endsWith("/SKILL.md"))
    .map((entry) => entry.path.slice(0, -"SKILL.md".length));
  return tree.filter((entry) => entry.type === "blob" &&
    (entry.mode === "100644" || entry.mode === "100755") &&
    entry.path.startsWith(prefix) && entry.path !== candidate.path &&
    validSkillPath(entry.path.slice(prefix.length)) &&
    !nested.some((dir) => entry.path.startsWith(dir)))
    .sort((a, b) => a.path.localeCompare(b.path));
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
): Promise<{ files: SkillFile[]; warning?: string; unread?: boolean }> {
  const files: SkillFile[] = [];
  const cached = new Map(previous.map((file) => [file.blobSha, file]));
  const prefix = skillPath.slice(0, -"SKILL.md".length);
  let total = 0;
  for (const entry of entries) {
    if ((entry.size ?? 0) > MAX_SKILL_FILE_BYTES || total + (entry.size ?? 0) > MAX_SKILL_BYTES) {
      return { files: [], warning: `Companion files exceed the ${MAX_SKILL_FILE_BYTES}-byte file cap or ${MAX_SKILL_BYTES}-byte skill cap. Reduce their size, then sync again.` };
    }
    const old = cached.get(entry.sha);
    const read = old ? null : await reader.readFile(repo, entry.path, ref);
    if (!old && read === null) {
      return { files: [], unread: true, warning: `${entry.path} could not be read. Sync again to retry. The stored skill is unchanged.` };
    }
    const bytes = old?.bytes ?? read?.bytes ?? Buffer.from(read?.text ?? "", "utf8");
    total += bytes.byteLength;
    if (bytes.byteLength > MAX_SKILL_FILE_BYTES || total > MAX_SKILL_BYTES) {
      return { files: [], warning: `Companion files exceed the ${MAX_SKILL_FILE_BYTES}-byte file cap or ${MAX_SKILL_BYTES}-byte skill cap. Reduce their size, then sync again.` };
    }
    if (read && read.blobSha !== entry.sha) {
      return { files: [], unread: true, warning: `${entry.path} changed during the read. Sync again to retry. The stored skill is unchanged.` };
    }
    files.push({ path: entry.path.slice(prefix.length), blobSha: entry.sha, size: bytes.byteLength, mode: entry.mode, bytes });
  }
  return { files };
}
