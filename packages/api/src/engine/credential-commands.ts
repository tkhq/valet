/**
 * `.valet/credentials.yaml` — the repo saying which commands need which
 * credentials, so the agent does not have to work it out.
 *
 * `valet-secrets` made a secret reachable without putting it in the
 * transcript, but it left the agent reasoning about credentials on every
 * call: which reference, which vault, whether it even has access. That
 * reasoning is where it went wrong, and a wrong guess looks exactly like a
 * broken integration. A repo already knows `stripe` needs `STRIPE_API_KEY`.
 * Declaring it once turns every later call into an ordinary command.
 *
 * ```yaml
 * commands:
 *   - command: stripe
 *     env: STRIPE_API_KEY
 *     reference: op://Eng/Stripe/secret key   # exact, or:
 *   - command: aws
 *     env: AWS_SECRET_ACCESS_KEY
 *     credential: aws                          # found by name at run time
 * ```
 *
 * `reference` pins the item. `credential` names it and lets the vault search
 * find it, which is the fallback for a repo that does not want a vault path
 * in its tree. Exactly one of the two per entry: a command with both is
 * ambiguous about which wins, and one with neither resolves nothing.
 *
 * A declaration is not a grant. The wrapper resolves through the same broker
 * and the same owner rule as a hand-typed `valet-secrets run`, so a repo
 * cannot name its way into a vault the session could not already read.
 */
import { parse as parseYaml } from "yaml";

/** One declared command-to-credential binding. */
export interface CredentialCommand {
  /** The command an agent types, e.g. `stripe`. Becomes a wrapper of the
   * same name ahead of the real binary on PATH. */
  command: string;
  /** The environment variable the real command reads. */
  env: string;
  /** An exact `op://vault/item/field`. Mutually exclusive with `credential`. */
  reference?: string;
  /** A name for the vault search to resolve. Mutually exclusive with `reference`. */
  credential?: string;
}

export const CREDENTIAL_COMMANDS_PATH = ".valet/credentials.yaml";

/** A command name has to be a bare filename: it becomes a path under
 * /usr/local/bin, and anything with a slash or a space would either escape
 * that directory or never be found. */
const COMMAND_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Same shape `export` accepts, checked here so a bad name never reaches a
 * shell that would quote the VALUE next to it in its error. */
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Reads and validates the repo's declarations. `null` when the file is
 * absent, which is the ordinary case and not an error. Throws on a malformed
 * file: a typo that silently dropped a command would leave the agent with a
 * command that quietly does not authenticate, which is the failure this file
 * exists to remove.
 */
export async function loadCredentialCommands(
  read: (path: string) => Promise<string | null>,
): Promise<CredentialCommand[] | null> {
  const raw = await read(CREDENTIAL_COMMANDS_PATH);
  if (raw === null) return null;
  const parsed: unknown = parseYaml(raw);
  if (parsed === null || parsed === undefined) return [];
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${CREDENTIAL_COMMANDS_PATH} must contain a YAML mapping`);
  }
  const commands = (parsed as Record<string, unknown>).commands;
  if (commands === undefined) return [];
  if (!Array.isArray(commands)) {
    throw new Error(`${CREDENTIAL_COMMANDS_PATH}: commands must be a list`);
  }

  const out: CredentialCommand[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of commands.entries()) {
    const at = `${CREDENTIAL_COMMANDS_PATH}: commands[${i}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${at} must be a mapping`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.command !== "string" || !COMMAND_RE.test(e.command)) {
      throw new Error(`${at}: command must be a bare command name`);
    }
    if (typeof e.env !== "string" || !ENV_RE.test(e.env)) {
      throw new Error(`${at}: env must be a valid environment variable name`);
    }
    const hasReference = typeof e.reference === "string" && e.reference !== "";
    const hasCredential = typeof e.credential === "string" && e.credential !== "";
    if (hasReference === hasCredential) {
      throw new Error(`${at}: set exactly one of reference or credential`);
    }
    if (hasReference && !(e.reference as string).startsWith("op://")) {
      throw new Error(`${at}: reference must be an op:// secret reference`);
    }
    if (seen.has(e.command)) {
      throw new Error(`${at}: ${e.command} is declared more than once`);
    }
    seen.add(e.command);
    out.push({
      command: e.command,
      env: e.env,
      ...(hasReference ? { reference: e.reference as string } : {}),
      ...(hasCredential ? { credential: e.credential as string } : {}),
    });
  }
  return out;
}
