import { randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytesCount: number): string {
  const bytes = randomBytes(bytesCount);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % 32];
  return out;
}

export function newWakeupId(): string {
  return `wk_${base32(20)}`;
}

export function newLeaseId(): string {
  return `ls_${base32(20)}`;
}
