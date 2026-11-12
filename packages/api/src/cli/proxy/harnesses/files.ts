import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ConfigError } from "../../exit.js";

export function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Keep symlinks, file modes, and complete files across interrupted writes. */
export function writeAtomicText(path: string, text: string, privateFile = false): void {
  const target = existsSync(path) ? realpathSync(path) : path;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const mode = privateFile || !existsSync(target) ? 0o600 : statSync(target).mode & 0o777;
  const temp = `${target}.valet-${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, text, { mode, flag: "wx" });
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function assertUnchanged(path: string, original: string): void {
  if (readText(path) !== original) throw new ConfigError(`${path} changed while setup waited for approval. Run setup again to keep those changes.`);
}

export function backupSettings(path: string): string {
  // Keep the first recovery copy when a later forced setup also has conflicts.
  let backup = `${path}.valet-backup`;
  for (let n = 1; existsSync(backup); n += 1) backup = `${path}.valet-backup.${n}`;
  copyFileSync(path, backup);
  chmodSync(backup, 0o600);
  return `Saved the old settings to ${backup}.`;
}

export function installedVersion(command: string): string | undefined {
  try {
    return execFileSync(command, ["--version"], { timeout: 5000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return undefined;
  }
}

export function versionParts(version: string): number[] | undefined {
  const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:[-+\s]|$)/.exec(version);
  return match ? match.slice(1).map(Number) : undefined;
}
