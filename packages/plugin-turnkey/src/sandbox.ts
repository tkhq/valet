/**
 * What commit signing puts in a sandbox, and where. The request action
 * writes all of it after approval; sandbox prep only installs `valet-sign`
 * and points git at it.
 *
 *   /run/valet/turnkey/session.json   P-256 session API key, 0600, made in
 *                                     the sandbox by `tk api-key generate`
 *                                     and registered in Turnkey with the
 *                                     approval window as its expiry.
 *   /run/valet/turnkey/env            TURNKEY_* variables `valet-sign` exports.
 *   /usr/local/bin/valet-sign         git's `gpg.ssh.program`: execs `tk ssh git-sign`.
 */
import type { Sandbox } from "@valet/engine";

export const TURNKEY_DIR = "/run/valet/turnkey";
export const SESSION_KEY_FILE = `${TURNKEY_DIR}/session.json`;
export const ENV_FILE = `${TURNKEY_DIR}/env`;
export const SIGN_PROGRAM_PATH = "/usr/local/bin/valet-sign";
export const TK_PATH = "/usr/local/bin/tk";

/** The variable `valet-sign` reads to pick the signing key. */
export const PRIVATE_KEY_ID_VAR = "TURNKEY_PRIVATE_KEY_ID";

export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Reads `public_key` out of tk's api-key file. */
export function publicKeyFromKeyFile(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || !("public_key" in parsed)) return null;
    const value = parsed.public_key;
    return typeof value === "string" && /^[0-9a-fA-F]{66}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Makes a new P-256 API key pair in the sandbox with `tk api-key generate`
 * and returns its public half. The private half stays in the sandbox, in
 * `SESSION_KEY_FILE` (0600). A previous pair is replaced: each approval gets
 * its own key, registered with the approval window as its expiry.
 */
export async function generateSessionKey(sandbox: Sandbox): Promise<string> {
  await run(
    sandbox,
    `mkdir -p ${TURNKEY_DIR} && chmod 700 ${TURNKEY_DIR} && rm -f ${SESSION_KEY_FILE} && ` +
      `${TK_PATH} api-key generate --output ${SESSION_KEY_FILE} --message-format json >/dev/null && chmod 600 ${SESSION_KEY_FILE}`,
    "generating the session key (check that the sandbox image ships /usr/local/bin/tk)",
  );
  const publicKey = publicKeyFromKeyFile(await sandbox.readFile(SESSION_KEY_FILE));
  if (!publicKey) throw new Error(`${SESSION_KEY_FILE} has no P-256 public key.`);
  return publicKey;
}

/** The `TURNKEY_*` lines `valet-sign` exports before it execs `tk`. */
export function envFileText(args: { organizationId: string; apiBaseUrl: string; privateKeyId: string }): string {
  return [
    `TURNKEY_ORGANIZATION_ID=${args.organizationId}`,
    `TURNKEY_API_BASE_URL=${args.apiBaseUrl}`,
    `${PRIVATE_KEY_ID_VAR}=${args.privateKeyId}`,
  ].join("\n") + "\n";
}

/**
 * Turns signing on for the key just approved: writes the env file
 * `valet-sign` reads, and points git at the public key. Written after
 * approval, not at prep, so commits before approval stay unsigned instead of
 * failing.
 */
export async function enableSandboxSigning(
  sandbox: Sandbox,
  args: { organizationId: string; apiBaseUrl: string; privateKeyId: string; publicKeyLine: string; committerEmail: string },
): Promise<void> {
  await run(
    sandbox,
    `mkdir -p ${TURNKEY_DIR} && printf '%s' ${shQuote(envFileText(args))} > ${ENV_FILE}.tmp && ` +
      `chmod 600 ${ENV_FILE}.tmp && mv ${ENV_FILE}.tmp ${ENV_FILE}`,
    "recording the signing key id",
  );
  await run(
    sandbox,
    // committer.email, not user.email: the author stays the Valet identity,
    // and prep's git-identity step (user.*) does not undo it on resume.
    `git config --global user.signingkey ${shQuote(`key::${args.publicKeyLine}`)} && ` +
      `git config --global committer.email ${shQuote(args.committerEmail)} && git config --global commit.gpgsign true`,
    "pointing git at the signing key",
  );
}

/** Turns signing off again after a revoke. Commits go back to unsigned. */
export async function disableSandboxSigning(sandbox: Sandbox): Promise<void> {
  await run(
    sandbox,
    `git config --global --unset commit.gpgsign; git config --global --unset user.signingkey; ` +
      `git config --global --unset committer.email; ` +
      `rm -f ${ENV_FILE} ${SESSION_KEY_FILE}; true`,
    "turning signing off",
  );
}

async function run(sandbox: Sandbox, command: string, what: string): Promise<void> {
  const res = await sandbox.exec(command);
  if (res.exitCode !== 0) {
    throw new Error(`${what} failed in the sandbox (exit ${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}`);
  }
}
