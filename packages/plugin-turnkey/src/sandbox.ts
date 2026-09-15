/**
 * What commit signing puts in a sandbox, and where. Shared by the action
 * (which turns signing on after approval) and the api's prep step (which
 * installs the session key and the git config before the agent runs).
 *
 *   /run/valet/turnkey/session.json   P-256 session API key, 0600, made in
 *                                     the sandbox by `tk api-key generate`.
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

/**
 * Turns signing on for the key just approved: records the Turnkey private
 * key id for `valet-sign`, and points git at the public key. Written after
 * approval, not at prep, so commits before approval stay unsigned instead of
 * failing.
 */
export async function enableSandboxSigning(
  sandbox: Sandbox,
  args: { privateKeyId: string; publicKeyLine: string },
): Promise<void> {
  const setVar =
    `mkdir -p ${TURNKEY_DIR} && ` +
    `{ grep -v '^${PRIVATE_KEY_ID_VAR}=' ${ENV_FILE} 2>/dev/null; ` +
    `printf '%s=%s\\n' ${PRIVATE_KEY_ID_VAR} ${shQuote(args.privateKeyId)}; } > ${ENV_FILE}.tmp && ` +
    `mv ${ENV_FILE}.tmp ${ENV_FILE}`;
  await run(sandbox, setVar, "recording the signing key id");
  await run(
    sandbox,
    `git config --global user.signingkey ${shQuote(`key::${args.publicKeyLine}`)} && git config --global commit.gpgsign true`,
    "pointing git at the signing key",
  );
}

/** Turns signing off again after a revoke. Commits go back to unsigned. */
export async function disableSandboxSigning(sandbox: Sandbox): Promise<void> {
  await run(
    sandbox,
    `git config --global --unset commit.gpgsign; git config --global --unset user.signingkey; ` +
      `{ grep -v '^${PRIVATE_KEY_ID_VAR}=' ${ENV_FILE} 2>/dev/null || true; } > ${ENV_FILE}.tmp && mv ${ENV_FILE}.tmp ${ENV_FILE}; true`,
    "turning signing off",
  );
}

async function run(sandbox: Sandbox, command: string, what: string): Promise<void> {
  const res = await sandbox.exec(command);
  if (res.exitCode !== 0) {
    throw new Error(`${what} failed in the sandbox (exit ${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}`);
  }
}
