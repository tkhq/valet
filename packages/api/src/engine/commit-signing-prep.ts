/**
 * The `turnkey-session-key` prep step (agent commit signing design).
 *
 * 1. `tk api-key generate` writes a P-256 key pair to
 *    `/run/valet/turnkey/session.json` (0600) inside the sandbox. The private
 *    half never leaves the sandbox.
 * 2. The public half is registered on `valet-agent` in the user's Turnkey
 *    sub-organization with an expiry (`CREATE_API_KEYS_V2`), through
 *    `snap.commitSigning.issueSessionKey`.
 * 3. `/run/valet/turnkey/env` gets the organization id and base URL that
 *    `valet-sign` exports before it execs `tk`.
 *
 * A sandbox that already has a session key keeps it: prep re-runs on resume,
 * and a new key per resume would leave the old ones registered until the
 * sweep. The step is declared non-critical, so a Turnkey failure here logs
 * and the session starts unsigned.
 */
import type { Sandbox } from "@valet/engine";
import { ENV_FILE, SESSION_KEY_FILE, TK_PATH, TURNKEY_DIR, shQuote } from "@valet/plugin-turnkey/sandbox";
import type { CommitSigningSnapshot } from "./sandbox-spec.js";

const GENERATE_CMD = `mkdir -p ${TURNKEY_DIR} && [ -f ${SESSION_KEY_FILE} ] || ${TK_PATH} api-key generate --output ${SESSION_KEY_FILE} --message-format json`;

/** Reads `public_key` out of tk's api-key file without a JSON parser dependency on the sandbox side. */
export function publicKeyFromKeyFile(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const value = (parsed as { public_key?: unknown }).public_key;
    return typeof value === "string" && /^[0-9a-fA-F]{66}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function envFileText(signing: Pick<CommitSigningSnapshot, "subOrgId" | "apiBaseUrl">, privateKeyId?: string): string {
  const lines = [`TURNKEY_ORGANIZATION_ID=${signing.subOrgId}`, `TURNKEY_API_BASE_URL=${signing.apiBaseUrl}`];
  if (privateKeyId) lines.push(`TURNKEY_PRIVATE_KEY_ID=${privateKeyId}`);
  return `${lines.join("\n")}\n`;
}

export async function installSessionKey(sandbox: Sandbox, signing: CommitSigningSnapshot): Promise<void> {
  const generate = await sandbox.exec(GENERATE_CMD);
  if (generate.exitCode !== 0) {
    throw new Error(
      `commit signing: tk api-key generate failed (exit ${generate.exitCode}): ${generate.stderr.trim() || generate.stdout.trim()}. ` +
        "Check that the sandbox image ships /usr/local/bin/tk.",
    );
  }

  let existing = "";
  try {
    existing = await sandbox.readFile(ENV_FILE);
  } catch {
    existing = "";
  }
  const alreadyEnrolled = existing.includes("TURNKEY_ORGANIZATION_ID=");

  if (!alreadyEnrolled) {
    const publicKey = publicKeyFromKeyFile(await sandbox.readFile(SESSION_KEY_FILE));
    if (!publicKey) {
      throw new Error("commit signing: the session key file has no P-256 public key. Delete /run/valet/turnkey and start the session again.");
    }
    await signing.issueSessionKey(publicKey);
  }

  // Keep a TURNKEY_PRIVATE_KEY_ID line a previous approval wrote in this sandbox.
  const keyIdLine = existing.split("\n").find((l) => l.startsWith("TURNKEY_PRIVATE_KEY_ID="));
  const privateKeyId = keyIdLine?.slice("TURNKEY_PRIVATE_KEY_ID=".length);
  const write = await sandbox.exec(
    `printf '%s' ${shQuote(envFileText(signing, privateKeyId))} > ${ENV_FILE} && chmod 600 ${ENV_FILE}`,
  );
  if (write.exitCode !== 0) {
    throw new Error(`commit signing: writing ${ENV_FILE} failed (exit ${write.exitCode}): ${write.stderr.trim()}`);
  }
}
