/**
 * `valet proxy setup|token|remove <harness>` — point a local coding harness
 * at the Valet LLM proxy (`docs/specs/2026-10-27-cli-proxy-setup-design.md`).
 *
 *   setup   Ask for a proxy key (the person approves it in the browser),
 *           store it in the CLI profile, and write the harness config.
 *   token   Print the stored key. The harness runs this as its key helper,
 *           so it prints only the key and makes no network call.
 *   remove  Remove the harness config that setup wrote, revoke the key,
 *           and forget it.
 *
 * `run` builds the real deps and delegates to the pure `runProxy`.
 */
import { accessSync, constants } from "node:fs";
import { hostname } from "node:os";
import { basename, delimiter, join } from "node:path";
import { InstanceClient } from "../client.js";
import type { ProxyKeyRecord, ValetConfig } from "../config.js";
import { updateConfig } from "../config.js";
import { deviceCodeInstructions, openInBrowser, pollProxyKeyRequest, startProxyKeyRequest } from "../device-login.js";
import { ApiError, ExitCode } from "../exit.js";
import { harnessAdapter, harnessIds, type HarnessAdapter, type HarnessTarget } from "../proxy/harnesses/index.js";
import { parseGlobalFlags, printErr, printLine } from "../output.js";
import { resolveInstance, type ResolvedInstance } from "../resolve.js";
import type { CliContext } from "../types.js";
import type { ProxySettingsResponse } from "../../wire/types.js";

/** The subset of `InstanceClient` the `proxy` command needs. */
export interface ProxyClient {
  proxySettings(): Promise<ProxySettingsResponse>;
  deleteProxyKey(id: string): Promise<void>;
}

export interface ProxyDeps {
  client(instance: ResolvedInstance): ProxyClient;
  /** Ask the instance for a key, show the code, and wait for the person's approval. */
  requestKey(opts: { url: string; cliToken: string; keyName: string }): Promise<ProxyKeyRecord>;
  /** Store (or, with `undefined`, forget) a profile's key for a harness. */
  saveKey(profile: string, harness: string, key: ProxyKeyRecord | undefined): Promise<void>;
  adapter(id: string | undefined): HarnessAdapter | undefined;
  /** Absolute path of the `valet` binary for the key helper, or undefined when none is found. */
  valetPath(): string | undefined;
  hostname(): string;
  env: NodeJS.ProcessEnv;
}

const USAGE = `usage: valet proxy <setup|token|remove> <harness> [--instance <name>]

  setup   Ask for a proxy key and point the harness at the Valet proxy
          --force   replace conflicting harness settings (saves a backup)
          --rotate  replace the stored key with a new one
  token   Print the stored key (the harness's key helper runs this)
  remove  Remove the harness settings, and revoke and forget the key`;

/** Flags that take no value. `parseGlobalFlags` reads `--force claude-code` as a value, so give it back. */
const BOOLEAN_FLAGS = ["force", "rotate"] as const;

export function parseProxyArgs(args: string[]): { sub?: string; harness?: string; instance?: string; force: boolean; rotate: boolean } {
  const parsed = parseGlobalFlags(args);
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
  };
}

/** Quote a word for a POSIX shell, when it needs it. */
export function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

export function helperCommand(valetPath: string, harness: string, instance: string): string {
  return `${shellWord(valetPath)} proxy token ${harness} --instance ${shellWord(instance)}`;
}

/** The running binary when it is `valet` (the single binary), else the first `valet` on PATH. */
export function findValetPath(execPath: string, env: NodeJS.ProcessEnv): string | undefined {
  if (/^valet(\.exe)?$/i.test(basename(execPath))) return execPath;
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

export async function runProxy(args: string[], config: ValetConfig, deps: ProxyDeps): Promise<number> {
  const opts = parseProxyArgs(args);
  if (opts.sub !== "setup" && opts.sub !== "token" && opts.sub !== "remove") {
    printErr(USAGE);
    return ExitCode.Usage;
  }
  const adapter = deps.adapter(opts.harness);
  if (!adapter) {
    printErr(`${opts.harness ? `Unknown harness "${opts.harness}"` : "Name a harness"}. Supported: ${harnessIds().join(", ")}.`);
    printErr(USAGE);
    return ExitCode.Usage;
  }
  const instance = resolveInstance({ flag: opts.instance, env: deps.env.VALET_INSTANCE, config });
  const profile = config.profiles?.[instance.name];
  const instanceUrl = instance.url.replace(/\/$/, "");

  if (opts.sub === "token") {
    const key = profile?.proxyKeys?.[adapter.id];
    if (!key) {
      printErr(`No proxy key for ${adapter.id} on instance "${instance.name}". Run \`valet proxy setup ${adapter.id}\`.`);
      return ExitCode.AuthFailure;
    }
    printLine(key.key);
    return ExitCode.OK;
  }

  const valetPath = deps.valetPath();
  const target: HarnessTarget = {
    instanceUrl,
    helperCommand: valetPath ? helperCommand(valetPath, adapter.id, instance.name) : "",
  };

  if (opts.sub === "remove") {
    const report = adapter.unapply(target);
    for (const line of report.removed) printLine(`Removed ${line} from ${report.path}.`);
    for (const line of report.kept) printErr(`Kept ${line} in ${report.path}.`);
    const key = profile?.proxyKeys?.[adapter.id];
    if (key) {
      await revokeKey(deps.client(instance), key);
      await deps.saveKey(instance.name, adapter.id, undefined);
      printLine(`Revoked and forgot proxy key ${key.name}.`);
    } else {
      printLine(`No proxy key for ${adapter.id} on instance "${instance.name}".`);
    }
    return ExitCode.OK;
  }

  // setup
  const cliToken = profile?.cli?.accessToken;
  if (!cliToken) {
    printErr(`\`valet proxy setup\` needs a browser sign-in. Run \`valet login ${instanceUrl}\` without --api-key, then run this command again.`);
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
  if (!valetPath) {
    printErr(`Could not find the valet binary for the ${adapter.label} key helper. Put \`valet\` on your PATH, then run this command again.`);
    return ExitCode.Failure;
  }

  // Plan before the key request, so a refused setup leaves no key behind.
  const plan = adapter.plan(target);
  if (plan.conflicts.length > 0 && !opts.force) {
    printErr(`${plan.path} has settings that \`valet proxy setup\` did not write:`);
    for (const conflict of plan.conflicts) printErr(`  ${conflict}`);
    printErr("Run again with --force to replace them. Setup saves a backup first.");
    return ExitCode.Failure;
  }

  const stored = profile?.proxyKeys?.[adapter.id];
  let key = stored;
  if (!key || opts.rotate) {
    key = await deps.requestKey({ url: instanceUrl, cliToken, keyName: `${adapter.id}@${deps.hostname()}` });
    await deps.saveKey(instance.name, adapter.id, key);
    printLine(`Stored proxy key ${key.name} in instance profile "${instance.name}".`);
  } else {
    printLine(`Using the stored proxy key ${key.name}.`);
  }

  for (const line of plan.apply({ force: opts.force })) printLine(line);
  if (opts.rotate && stored && stored.id !== key.id) {
    await revokeKey(client, stored);
    printLine(`Revoked the old proxy key ${stored.name}.`);
  }
  for (const warning of adapter.envWarnings(deps.env)) printErr(`warning: ${warning}`);
  printLine(adapter.nextStep);
  return ExitCode.OK;
}

/** Revoke a key on the server. A key already gone is fine; any other failure warns and continues. */
async function revokeKey(client: ProxyClient, key: ProxyKeyRecord): Promise<void> {
  try {
    await client.deleteProxyKey(key.id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return;
    printErr(`warning: could not revoke proxy key ${key.name} (${key.id}): ${err instanceof Error ? err.message : String(err)}. Revoke it in Settings > API keys.`);
  }
}

async function requestKey(opts: { url: string; cliToken: string; keyName: string }): Promise<ProxyKeyRecord> {
  const pending = await startProxyKeyRequest(opts.url, { cliToken: opts.cliToken, keyName: opts.keyName });
  const opened = await openInBrowser(`${pending.url}${pending.verificationPath}`);
  for (const line of deviceCodeInstructions(pending, opened, `approve proxy key ${opts.keyName}`)) printErr(line);
  printErr("Waiting for approval...");
  // The first poll waits one interval, so the person has time to act.
  await new Promise<void>((resolve) => setTimeout(resolve, pending.interval * 1000));
  const key = await pollProxyKeyRequest(pending);
  return { id: key.id, key: key.key, name: key.name, createdAt: key.created_at };
}

async function saveKey(profileName: string, harness: string, key: ProxyKeyRecord | undefined): Promise<void> {
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

export async function run(args: string[], ctx: CliContext): Promise<number> {
  return runProxy(args, ctx.config, {
    client: (instance) => new InstanceClient({ url: instance.url, apiKey: instance.apiKey }),
    requestKey,
    saveKey,
    adapter: harnessAdapter,
    valetPath: () => findValetPath(process.execPath, process.env),
    hostname,
    env: process.env,
  });
}
