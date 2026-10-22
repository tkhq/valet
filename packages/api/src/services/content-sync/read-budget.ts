import type { SkillRepoReader } from "../skill-repo-reader.js";

/** Shared by body reads, companion reads, and fallback discovery in one sync. */
export const MAX_SYNC_READS = 600;
const READ_WINDOW_MS = 180_000;

export function budgetedReader(reader: SkillRepoReader, now = Date.now): SkillRepoReader {
  let reads = 0;
  const deadline = now() + READ_WINDOW_MS;
  const signal = AbortSignal.timeout(READ_WINDOW_MS);
  function take(): void {
    if (++reads > MAX_SYNC_READS || now() >= deadline) {
      throw new Error(`Repository sync reached its ${MAX_SYNC_READS}-read or 180-second budget. Import a smaller repository subdirectory, then sync again.`);
    }
  }
  return {
    head: (repo, ref) => { take(); return reader.head(repo, ref, signal); },
    listTree: (repo, sha) => { take(); return reader.listTree(repo, sha, signal); },
    listDirectory: (repo, path, ref) => { take(); return reader.listDirectory(repo, path, ref, signal); },
    readFile: (repo, path, ref) => { take(); return reader.readFile(repo, path, ref, signal); },
  };
}
