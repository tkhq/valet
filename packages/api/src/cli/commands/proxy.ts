/**
 * `valet proxy setup|token|remove <harness>` — point a local coding harness
 * at the Valet LLM proxy (`docs/specs/2026-10-27-cli-proxy-setup-design.md`).
 *
 *   setup   Ask for a proxy key (the person approves it in the browser),
 *           store it in the CLI profile, check the key helper, and write
 *           the harness config.
 *   token   Print the stored key. The harness runs this as its key helper,
 *           so it prints only the key and makes no network call.
 *   remove  Remove the harness config that setup wrote, revoke the key,
 *           and forget it.
 *
 * `run` builds the real deps and delegates to the pure `runProxy`.
 */
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { hostname } from "node:os";
import { basename, delimiter, join } from "node:path";
import { InstanceClient } from "../client.js";
import type { PendingLogin, ProfileConfig, ProxyKeyRecord, ValetConfig } from "../config.js";
import { updateConfig } from "../config.js";
import { deviceCodeInstructions, openInBrowser, pollProxyKeyRequest, startProxyKeyRequest } from "../device-login.js";
import { ApiError, AuthError, ExitCode } from "../exit.js";
import { harnessAdapter, harnessIds, type HarnessAdapter, type HarnessTarget } from "../proxy/harnesses/index.js";
import { parseGlobalFlags, printErr, printLine } from "../output.js";
import { resolveInstance, type ResolvedInstance } from "../resolve.js";
import type { CliContext } from "../types.js";
import type { ProxyKeyStatusResponse, ProxySettingsResponse } from "../../wire/types.js";

/** The subset of `InstanceClient` the `proxy` command needs. */
export interface ProxyClient {
  proxySettings(): Promise<ProxySettingsResponse>;
  proxyKeyStatus(id: string): Promise<ProxyKeyStatusResponse>;
  deleteProxyKey(id: string): Promise<void>;
}

export type HelperResult = { ok: true; stdout: string } | { ok: false; error: string };

export interface ProxyDeps {
  client(instance: ResolvedInstance): ProxyClient;
  /** Start a key request (`POST /api/cli/device/code`, purpose `proxy-key`). */
  startKeyRequest(opts: { url: string; cliToken: string; keyName: string }): Promise<PendingLogin>;
  /** Poll a key request until the person allows or denies it. Throws `AuthError` when it ends without a key. */
  pollKeyRequest(pending: PendingLogin): Promise<ProxyKeyRecord>;
  openUrl(url: string): Promise<boolean>;
  /** Store (or, with `undefined`, forget) a profile's key for a harness. */
  saveKey(profile: string, harness: string, key: ProxyKeyRecord | undefined): Promise<void>;
  /** Store (or forget) a waiting key request, keyed by `<profile>/<harness>`. */
  savePending(slot: string, pending: PendingLogin | undefined): Promise<void>;
  /** Run the key helper command the harness will run, in a shell. */
  runHelper(command: string): Promise<HelperResult>;
  adapter(id: string | undefined): HarnessAdapter | undefined;
  /** Absolute path of the `valet` binary for the key helper, or undefined when none is found. */
  valetPath(): string | undefined;
  hostname(): string;
  now(): number;
  env: NodeJS.ProcessEnv;
}

const USAGE = `usage: valet proxy <setup|token|remove> <harness> [--instance <name>]

  setup   Ask for a proxy key and point the harness at the Valet proxy
          --no-wait  start the key request, print the code, and exit;
                     run setup again after you approve it
          --force    replace conflicting harness settings (saves a backup),
                     and skip the check for exported keys
          --rotate   replace the stored key with a new one
  token   Print the stored key (the harness's key helper runs this)
  remove  Remove the harness settings, and revoke and forget the key

Harnesses: ${harnessIds().join(", ")}`;

/** Flags that take no value. `parseGlobalFlags` reads `--force claude-code` as a value, so give it back. */
const BOOLEAN_FLAGS = ["force", "rotate", "no-wait", "help"] as const;

export function parseProxyArgs(args: string[]): {
  sub?: string; harness?: string; instance?: string; force: boolean; rotate: boolean; noWait: boolean; help: boolean;
} {
  const parsed = parseGlobalFlags(args.map((arg) => (arg === "-h" ? "--help" : arg)));
  const rest = [...parsed.rest];
  const bools: Record<string, boolean> = {};
  for (const name of BOOLEAN_FLAGS) {
    const value = parsed.flags[name];
    if (typeof value === "string") rest.push(value);
    bools[name] = value !== undefined && value !== "false";
  }
  return {
    sub: rest[0],
    harness: rest[1],
    instance: typeof parsed.flags.instance === "string" ? parsed.flags.instance : undefined,
    force: bools.force ?? false,
    rotate: bools.rotate ?? false,
    noWait: bools["no-wait"] ?? false,
    help: (bools.help ?? false) || rest[0] === "help",
  };
}

/** Quote a word for a POSIX shell, when it needs it. */
export function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** `proxy token <harness> --instance <name>`: the part of the helper command that names harness and instance. */
export function helperArgs(harness: string, instance: string): string {
  return `proxy token ${harness} --instance ${shellWord(instance)}`;
}

/**
 * The key helper command. `VALET_DATA_DIR` goes into the command when it is
 * set, because a harness started from an IDE may not inherit the shell's
 * environment, and the helper would then read another config.
 */
export function helperCommand(valetPath: string, harness: string, instance: string, env: NodeJS.ProcessEnv): string {
  const prefix = env.VALET_DATA_DIR ? `VALET_DATA_DIR=${shellWord(env.VALET_DATA_DIR)} ` : "";
  return `${prefix}${shellWord(valetPath)} ${helperArgs(harness, instance)}`;
}

/**
 * The running binary, unless this is a script under a runtime (`node`,
 * `bun`, as in development), then the first `valet` on PATH. A downloaded
 * release binary keeps its file name (`valet-darwin-arm64`), so the name
 * cannot be the test.
 */
export function findValetPath(execPath: string, env: NodeJS.ProcessEnv): string | undefined {
  if (!/^(node|bun)(\.exe)?$/i.test(basename(execPath))) return execPath;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "valet");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here: try the next PATH entry.
    }
  }
  return undefined;
}

function pendingSlot(profile: string, harness: string): string {
  return `${profile}/${harness}`;
}

export async function runProxy(args: string[], config: ValetConfig, deps: ProxyDeps): Promise<number> {
  const opts = parseProxyArgs(args);
  if (opts.help) {
    printLine(USAGE);
    return ExitCode.OK;
  }
  if (opts.sub !== "setup" && opts.sub !== "token" && opts.sub !== "remove") {
    printErr(USAGE);
    return ExitCode.Usage;
  }
  const adapter = deps.adapter(opts.harness);
  if (!adapter) {
    printErr(`${opts.harness ? `Unknown harness "${opts.harness}"` : "Name a harness"}. Supported: ${harnessIds().join(", ")}.`);
    return ExitCode.Usage;
  }
  const instance = resolveInstance({ flag: opts.instance, env: deps.env.VALET_INSTANCE, config });
  const profile = config.profiles?.[instance.name];

  if (opts.sub === "token") {
    const key = profile?.proxyKeys?.[adapter.id];
    if (!key) {
      printErr(`No proxy key for ${adapter.id} on instance "${instance.name}". Run \`valet proxy setup ${adapter.id}\`.`);
      return ExitCode.AuthFailure;
    }
    printLine(key.key);
    return ExitCode.OK;
  }

  if (opts.sub === "remove") {
    if (!profile?.proxyKeys?.[adapter.id]) printLine(`No proxy key for ${adapter.id} on instance "${instance.name}".`);
    await removeProxySetup(instance, profile, adapter, deps);
    return ExitCode.OK;
  }
  return setup(opts, config, instance, profile, adapter, deps);
}

async function setup(
  opts: ReturnType<typeof parseProxyArgs>,
  config: ValetConfig,
  instance: ResolvedInstance,
  profile: ProfileConfig | undefined,
  adapter: HarnessAdapter,
  deps: ProxyDeps,
): Promise<number> {
  const instanceUrl = instance.url.replace(/\/$/, "");
  const cliToken = profile?.cli?.accessToken;
  if (!cliToken) {
    printErr(profile?.apiKey
      ? `\`valet proxy setup\` needs a browser sign-in, not an API key. Run \`valet login ${instanceUrl}\` without --api-key, then run this command again.`
      : `\`valet proxy setup\` needs a browser sign-in, and proxy keys need an instance with real auth. Run \`valet login ${instanceUrl}\`, then run this command again.`);
    return ExitCode.AuthFailure;
  }
  const client = deps.client(instance);
  const settings = await client.proxySettings();
  if (!settings.enabled) {
    printErr("The Valet proxy is off for your org. An org admin can turn it on in Settings > Proxy.");
    return ExitCode.Failure;
  }
  if (!adapter.modes.includes(settings.mode)) {
    printErr(adapter.modeRefusal(settings.mode));
    return ExitCode.Failure;
  }
  const valetPath = deps.valetPath();
  if (!valetPath) {
    printErr(`Could not find the valet binary for the ${adapter.label} key helper. Put \`valet\` on your PATH, then run this command again.`);
    return ExitCode.Failure;
  }

  // Every check runs before the key request, so a refused setup leaves no key behind.
  const preflight = adapter.preflight(deps.env);
  if (preflight.blockers.length > 0) {
    printErr(`${adapter.label} cannot use the Valet proxy on this computer:`);
    for (const blocker of preflight.blockers) printErr(`  ${blocker}`);
    printErr(`Ask your ${adapter.label} admin to change the policy.`);
    return ExitCode.Failure;
  }
  if (preflight.shellBlockers.length > 0 && !opts.force) {
    for (const blocker of preflight.shellBlockers) printErr(blocker);
    printErr("Then run this command again. --force skips this check.");
    return ExitCode.Failure;
  }
  const target: HarnessTarget = {
    instanceUrl,
    helperCommand: helperCommand(valetPath, adapter.id, instance.name, deps.env),
    helperArgs: helperArgs(adapter.id, instance.name),
  };
  const plan = adapter.plan(target);
  if (plan.conflicts.length > 0 && !opts.force) {
    printErr(`${plan.path} has settings that \`valet proxy setup\` did not write:`);
    for (const conflict of plan.conflicts) printErr(`  ${conflict}`);
    printErr("Run again with --force to replace them. Setup saves a backup first.");
    return ExitCode.Failure;
  }

  const stored = profile?.proxyKeys?.[adapter.id];
  let key = stored;
  if (key && !opts.rotate && !(await keyStillWorks(client, key))) {
    printErr(`The stored proxy key ${key.name} no longer works. It was revoked or expired. Requesting a new key.`);
    key = undefined;
  }
  if (!key || opts.rotate) {
    const outcome = await requestKey(opts, config, instance.name, instanceUrl, cliToken, adapter, deps);
    if (typeof outcome === "number") return outcome;
    key = outcome;
    await deps.saveKey(instance.name, adapter.id, key);
    printLine(`Stored proxy key ${key.name} in instance profile "${instance.name}".`);
  } else {
    printLine(`Using the stored proxy key ${key.name}.`);
  }

  // Run the helper exactly as the harness will, before the harness points at it.
  const helper = await deps.runHelper(target.helperCommand);
  if (!helper.ok || helper.stdout.trim() !== key.key) {
    printErr(`The key helper did not print the stored key, so ${adapter.label} would fail. Setup left ${plan.path} unchanged.`);
    printErr(`  command: ${target.helperCommand}`);
    if (!helper.ok) printErr(`  error: ${helper.error}`);
    else printErr("  It printed something else. Check that the command runs this version of valet.");
    return ExitCode.Failure;
  }

  for (const line of plan.apply({ force: opts.force })) printLine(line);
  if (opts.rotate && stored && stored.id !== key.id) {
    if (await revokeKey(client, stored)) printLine(`Revoked the old proxy key ${stored.name}.`);
  }
  for (const warning of preflight.warnings) printErr(`warning: ${warning}`);
  if (preflight.shellBlockers.length > 0) {
    for (const blocker of preflight.shellBlockers) printErr(`warning: ${blocker}`);
  }
  for (const notice of adapter.notices) printLine(notice);
  printLine(adapter.nextStep);
  return ExitCode.OK;
}

/** Whether a stored key still works. Only a 404 means no: other failures propagate. */
async function keyStillWorks(client: ProxyClient, key: ProxyKeyRecord): Promise<boolean> {
  try {
    await client.proxyKeyStatus(key.id);
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return false;
    throw err;
  }
}

/**
 * Start or resume a key request, then wait for it unless `--no-wait`.
 * Returns the key, or an exit code when the command ends here.
 */
async function requestKey(
  opts: ReturnType<typeof parseProxyArgs>,
  config: ValetConfig,
  profileName: string,
  instanceUrl: string,
  cliToken: string,
  adapter: HarnessAdapter,
  deps: ProxyDeps,
): Promise<ProxyKeyRecord | number> {
  const slot = pendingSlot(profileName, adapter.id);
  const saved = config.pendingProxyKeys?.[slot];
  const resumed = saved !== undefined && saved.url === instanceUrl && saved.expiresAt > deps.now();
  const keyName = `${adapter.id}@${deps.hostname()}`;
  const pending = resumed ? saved : await deps.startKeyRequest({ url: instanceUrl, cliToken, keyName });
  if (!resumed) await deps.savePending(slot, pending);
  const pageUrl = `${pending.url}${pending.verificationPath}`;
  if (resumed) {
    printErr(`Resuming the proxy key request that waits for code ${pending.userCode} (open ${pageUrl}).`);
  } else {
    const opened = opts.noWait ? false : await deps.openUrl(pageUrl);
    for (const line of deviceCodeInstructions(pending, opened, `approve proxy key ${keyName}`)) printErr(line);
  }
  if (opts.noWait) {
    const minutes = Math.max(1, Math.round((pending.expiresAt - deps.now()) / 60_000));
    printErr(`After you choose Allow, run \`valet proxy setup ${adapter.id}\` again to finish. The code expires in ${minutes} minutes.`);
    return ExitCode.OK;
  }
  printErr("Waiting for approval...");
  try {
    const key = await deps.pollKeyRequest(pending);
    await deps.savePending(slot, undefined);
    return key;
  } catch (err) {
    if (err instanceof AuthError) {
      // The request ended: forget it, so the next setup starts a new one.
      await deps.savePending(slot, undefined);
      printErr(`valet proxy setup: ${err.message}`);
      return ExitCode.AuthFailure;
    }
    throw err;
  }
}

/**
 * Undo setup for one harness on one profile: remove the harness settings
 * setup wrote, revoke the key, and forget it. `valet proxy remove` and
 * `valet logout` both use this. Never throws for a server or file problem:
 * it reports the problem and the manual fix.
 */
export async function removeProxySetup(
  instance: ResolvedInstance,
  profile: ProfileConfig | undefined,
  adapter: HarnessAdapter,
  deps: Pick<ProxyDeps, "client" | "saveKey">,
): Promise<void> {
  try {
    const report = adapter.unapply({ instanceUrl: instance.url.replace(/\/$/, ""), helperArgs: helperArgs(adapter.id, instance.name) });
    for (const line of report.removed) printLine(`Removed ${line} from ${report.path}.`);
    for (const line of report.kept) printErr(`Kept ${line} in ${report.path}.`);
  } catch (err) {
    printErr(`warning: could not update the ${adapter.label} settings: ${err instanceof Error ? err.message : String(err)}`);
  }
  const key = profile?.proxyKeys?.[adapter.id];
  if (!key) return;
  if (await revokeKey(deps.client(instance), key)) printLine(`Revoked proxy key ${key.name}.`);
  await deps.saveKey(instance.name, adapter.id, undefined);
}

/** Revoke a key on the server. A key already gone counts as revoked; any other failure warns. */
async function revokeKey(client: ProxyClient, key: ProxyKeyRecord): Promise<boolean> {
  try {
    await client.deleteProxyKey(key.id);
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return true;
    printErr(`warning: could not revoke proxy key ${key.name} (${key.id}): ${err instanceof Error ? err.message : String(err)}. Revoke it in Settings > API keys.`);
    return false;
  }
}

function runHelper(command: string): Promise<HelperResult> {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", command], { timeout: 15_000, env: process.env }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: (stderr.trim() || err.message).split("\n")[0] ?? err.message });
      else resolve({ ok: true, stdout });
    });
  });
}

export async function saveKey(profileName: string, harness: string, key: ProxyKeyRecord | undefined): Promise<void> {
  await updateConfig((current) => {
    const profile = current.profiles?.[profileName];
    if (!profile) return current;
    const proxyKeys = { ...profile.proxyKeys };
    if (key) proxyKeys[harness] = key;
    else delete proxyKeys[harness];
    const { proxyKeys: _old, ...rest } = profile;
    const nextProfile = Object.keys(proxyKeys).length === 0 ? rest : { ...rest, proxyKeys };
    return { ...current, profiles: { ...current.profiles, [profileName]: nextProfile } };
  });
}

async function savePending(slot: string, pending: PendingLogin | undefined): Promise<void> {
  await updateConfig((current) => {
    const { [slot]: _old, ...rest } = current.pendingProxyKeys ?? {};
    const next = pending ? { ...rest, [slot]: pending } : rest;
    return { ...current, pendingProxyKeys: Object.keys(next).length > 0 ? next : undefined };
  });
}

export function realProxyDeps(): ProxyDeps {
  return {
    client: (instance) => new InstanceClient({ url: instance.url, apiKey: instance.apiKey }),
    startKeyRequest: (opts) => startProxyKeyRequest(opts.url, { cliToken: opts.cliToken, keyName: opts.keyName }),
    pollKeyRequest: async (pending) => {
      const key = await pollProxyKeyRequest(pending);
      return { id: key.id, key: key.key, name: key.name, createdAt: key.created_at };
    },
    openUrl: openInBrowser,
    saveKey,
    savePending,
    runHelper,
    adapter: harnessAdapter,
    valetPath: () => findValetPath(process.execPath, process.env),
    hostname,
    now: Date.now,
    env: process.env,
  };
}

export async function run(args: string[], ctx: CliContext): Promise<number> {
  return runProxy(args, ctx.config, realProxyDeps());
}
