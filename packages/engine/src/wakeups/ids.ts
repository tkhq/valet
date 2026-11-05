import { randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

function base32(bytesCount: number): string {
  const bytes = randomBytes(bytesCount);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % 32];
  return out;
}

function base36(count: number): string {
  const bytes = randomBytes(count);
  let out = "";
  for (const b of bytes) out += BASE36[b % 36];
  return out;
}

export function newWakeupId(): string {
  return `wk_${base32(20)}`;
}

export function newLeaseId(): string {
  return `ls_${base32(20)}`;
}

/**
 * A job exec id that is unique across sandbox handles and api restarts:
 * `job-<base36 epoch ms>-<8 random base36>`. Job files live in the pod for
 * its whole life, so a per-handle counter reused a live job's files after
 * a restart (fix wave 2, B1).
 */
export function newExecId(): string {
  return `job-${Date.now().toString(36)}-${base36(8)}`;
}

/**
 * Exec ids are interpolated into `/tmp/valet-jobs/<id>.*` paths, so only
 * `[a-z0-9]` runs joined by single dashes pass. Legacy counter ids
 * (`job-3`) still match.
 */
export const EXEC_ID_PATTERN = /^job-[a-z0-9]+(?:-[a-z0-9]+)*$/;
