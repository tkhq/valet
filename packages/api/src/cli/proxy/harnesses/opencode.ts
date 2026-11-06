/** OpenCode 1.x and 2.x provider settings with private file-based credentials. */
import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { configPath } from "../../config.js";
import { ConfigError } from "../../exit.js";
import type { HarnessAdapter, HarnessPlan, HarnessTarget, HarnessUnapplyReport } from "./index.js";
import { assertUnchanged, backupSettings, installedVersion, readText, versionParts, writeAtomicText } from "./files.js";
import { discoverOpenCodeCatalog } from "./opencode-catalog.js";

const PROVIDERS = ["anthropic", "openai"] as const;
type Settings = Record<string, unknown>;
type Field = { path: string[]; value: unknown };

function isRecord(value: unknown): value is Settings {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Settings {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ConfigError(`${label} must be an object. Fix the OpenCode config, then run setup again.`);
  return value;
}

function readSettings(raw: string, path: string): Settings {
  if (!raw.trim()) return {};
  const errors: ParseError[] = [];
  const value: unknown = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(value)) throw new ConfigError(`${path} must contain a valid JSON or JSONC object. Fix the file, then run setup again.`);
  return value;
}

function settingsPath(): string {
  if (process.env.OPENCODE_CONFIG) return resolve(process.env.OPENCODE_CONFIG);
  const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
  const json = join(dir, "opencode.json");
  const jsonc = join(dir, "opencode.jsonc");
  if (existsSync(json) && existsSync(jsonc)) throw new ConfigError(`Both ${json} and ${jsonc} exist. Set OPENCODE_CONFIG to the active file, then run setup again.`);
  return existsSync(jsonc) ? jsonc : json;
}

function credentialPath(target: Pick<HarnessTarget, "instanceUrl" | "helperArgs">): string {
  const suffix = createHash("sha256").update(JSON.stringify([target.instanceUrl, target.helperArgs])).digest("hex").slice(0, 24);
  return resolve(dirname(configPath()), "proxy-keys", `opencode-${suffix}.key`);
}

function baseUrl(target: Pick<HarnessTarget, "instanceUrl">, provider: string): string {
  return `${target.instanceUrl}/proxy/${provider}/v1`;
}

function edit(raw: string, fields: Field[]): string {
  let next = raw.trim() ? raw : "{}\n";
  for (const field of fields) next = applyEdits(next, modify(next, field.path, field.value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  return next;
}

export function opencodeVersionBlockers(version: string | undefined): string[] {
  const parts = version ? versionParts(version) : undefined;
  if (parts?.[0] === 1 || parts?.[0] === 2) return [];
  return ["Automatic setup supports OpenCode 1.x and 2.x. Install a supported version, then run setup again."];
}

function v2Settings(settings: Settings): boolean {
  const major = versionParts(installedVersion("opencode") ?? "")?.[0];
  if (settings.providers !== undefined && major === 1) {
    throw new ConfigError("The config uses OpenCode 2 settings, but OpenCode 1 is installed. Install OpenCode 2, then run setup again.");
  }
  return settings.providers !== undefined || major === 2;
}

function aliasDefaults(id: string): Settings {
  return { name: `Valet ${id === "openai" ? "OpenAI" : "Anthropic"}`, canonical: id, package: `@opencode/ai/providers/${id}` };
}

/** A model override must not redirect a Valet alias to another endpoint or credential. */
function checkModelOverrides(value: unknown, label: string, provider?: string): void {
  if (Array.isArray(value)) { for (const item of value) checkModelOverrides(item, label, provider); return; }
  if (!isRecord(value)) return;
  for (const [name, item] of Object.entries(value)) {
    if (name === "package" && provider && ["", "/responses", "/chat"].some((suffix) => item === `@opencode/ai/providers/${provider}${suffix}`)) continue;
    if (["baseURL", "apiKey", "package", "npm", "authorization", "x-api-key", "transport", "encoding"].includes(name)
      || ["authorization", "x-api-key"].includes(name.toLowerCase())) {
      throw new ConfigError(`${label} sets a connection override (${name}). Remove that model override, then run setup again.`);
    }
    checkModelOverrides(item, label, provider);
  }
}

/** Native model entries are partial overrides. Arrays replace their catalog defaults. */
function mergeModelSettings(defaults: Settings, overrides: Settings): Settings {
  return { ...defaults, ...Object.fromEntries(Object.entries(overrides).map(([name, value]): [string, unknown] => {
    const original = defaults[name];
    return [name, isRecord(original) && isRecord(value) ? mergeModelSettings(original, value) : value];
  })) };
}

function v2Plan(path: string, current: string, settings: Settings, target: HarnessTarget): HarnessPlan {
  const providers = record(settings.providers, "providers");
  const legacy = record(settings.provider, "provider");
  const keyPath = credentialPath(target);
  const keyRef = `{file:${keyPath}}`;
  const fields: Field[] = [];
  const conflicts: string[] = [];
  const catalog = discoverOpenCodeCatalog();
  for (const id of PROVIDERS) {
    if (isRecord(legacy[id]) && legacy[id].models !== undefined) {
      throw new ConfigError(`provider.${id}.models uses legacy model settings. Migrate those settings to OpenCode v2, then run setup again.`);
    }
    const alias = `valet-${id}`;
    const native = record(providers[id], `providers.${id}`);
    const existing = record(providers[alias], `providers.${alias}`);
    const options = record(existing.settings, `providers.${alias}.settings`);
    const wanted = { ...aliasDefaults(id), settings: { baseURL: baseUrl(target, id), apiKey: keyRef, transport: "http", encoding: "none" } };
    for (const [name, value] of Object.entries(wanted)) {
      const entries: Array<[string, unknown]> = name === "settings" && isRecord(value) ? Object.entries(value) : [[name, value]];
      for (const [field, item] of entries) {
        const previous = name === "settings" ? options[field] : existing[field];
        if (previous === item) continue;
        if (previous !== undefined) conflicts.push(`providers.${alias}.${name === "settings" ? `settings.${field}` : field} is set. Setup will replace it.`);
        fields.push({ path: ["providers", alias, ...(name === "settings" ? ["settings", field] : [field])], value: item });
      }
    }
    const models = mergeModelSettings(catalog[id], record(native.models, `providers.${id}.models`));
    const aliasModels = record(existing.models, `providers.${alias}.models`);
    for (const [model, config] of Object.entries(models)) {
      checkModelOverrides(config, `providers.${id}.models.${model}`, id);
      if (aliasModels[model] === undefined) fields.push({ path: ["providers", alias, "models", model], value: config });
    }
    checkModelOverrides(aliasModels, `providers.${alias}.models`, id);
    const headers = record(existing.headers, `providers.${alias}.headers`);
    for (const name of Object.keys(headers)) {
      if (!["authorization", "x-api-key"].includes(name.toLowerCase())) continue;
      conflicts.push(`providers.${alias}.headers.${name} overrides proxy authentication. Setup will remove it.`);
      fields.push({ path: ["providers", alias, "headers", name], value: undefined });
    }
    if (typeof settings.model === "string" && settings.model.startsWith(`${id}/`)) {
      fields.push({ path: ["model"], value: `valet-${settings.model}` });
    }
  }
  const next = edit(current, fields);
  return {
    path, conflicts, changes: fields.length > 0 ? ["Configure Valet provider aliases with private credentials."] : [],
    checkKey: (key) => readText(keyPath).trim() === key,
    apply({ force, key }) {
      assertUnchanged(path, current);
      if (conflicts.length > 0 && !force) throw new ConfigError(`${path} has conflicts. Run setup again with --force to save a backup and replace them.`);
      if (!key) throw new ConfigError("No OpenCode proxy key is available. Run `valet proxy setup opencode` again.");
      const lines = conflicts.length > 0 && existsSync(path) ? [backupSettings(path)] : [];
      writeAtomicText(keyPath, `${key}\n`, true);
      if (fields.length > 0) writeAtomicText(path, next);
      return [...lines, fields.length > 0 ? `Updated ${path}.` : `${path} is already set up.`, "OpenCode v2: choose a Valet Anthropic or Valet OpenAI model in `/models`."];
    },
  };
}

function unapplyV2(path: string, current: string, settings: Settings, target: Pick<HarnessTarget, "instanceUrl" | "helperArgs">): HarnessUnapplyReport {
  const providers = record(settings.providers, "providers");
  const keyPath = credentialPath(target);
  const keyRef = `{file:${keyPath}}`;
  const fields: Field[] = [];
  const removed: string[] = [];
  const kept: string[] = [];
  for (const id of PROVIDERS) {
    const alias = `valet-${id}`;
    const existing = record(providers[alias], `providers.${alias}`);
    const options = record(existing.settings, `providers.${alias}.settings`);
    if (options.apiKey !== keyRef) {
      if (Object.keys(existing).length > 0) kept.push(`providers.${alias} (setup did not write its credential for this instance)`);
      continue;
    }
    fields.push({ path: ["providers", alias, "settings", "apiKey"], value: undefined });
    removed.push(`providers.${alias}.settings.apiKey`);
    if (options.baseURL === baseUrl(target, id)) {
      fields.push({ path: ["providers", alias, "settings", "baseURL"], value: undefined });
      removed.push(`providers.${alias}.settings.baseURL`);
    } else if (options.baseURL !== undefined) kept.push(`providers.${alias}.settings.baseURL (it changed after setup)`);
    if (typeof settings.model === "string" && settings.model.startsWith(`${alias}/`)) {
      fields.push({ path: ["model"], value: settings.model.slice("valet-".length) });
      removed.push("Valet model prefix");
    }
  }
  const next = edit(current, fields);
  if (fields.length > 0) writeAtomicText(path, next);
  if (!next.includes(keyRef) && existsSync(keyPath)) unlinkSync(keyPath);
  return { path, removed, kept };
}

/** OAuth plugins can redirect requests away from configured provider endpoints. */
export function opencodeOauthBlockers(path: string): string[] {
  if (!existsSync(path)) return [];
  let auth: unknown;
  try { auth = JSON.parse(readText(path)); }
  catch { return [`${path} is not valid JSON. Fix the OpenCode auth file, then run setup again.`]; }
  if (!isRecord(auth)) return [`${path} must contain an object. Fix the OpenCode auth file, then run setup again.`];
  return PROVIDERS.filter((id) => isRecord(auth[id]) && auth[id].type === "oauth")
    .map((id) => `OpenCode has a saved ${id} OAuth account that can bypass the proxy. Run \`opencode auth logout\` to disconnect it, then run setup again.`);
}

export const opencodeAdapter: HarnessAdapter = {
  id: "opencode",
  label: "OpenCode",
  modes: ["centralized"],
  modeRefusal: () => "OpenCode automatic setup supports centralized proxy mode only. Ask your org admin to enable centralized mode, or use Settings > Proxy.",
  preflight(env) {
    const authPath = join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "auth.json");
    const version = installedVersion("opencode");
    const blockers = [...opencodeVersionBlockers(version), ...(versionParts(version ?? "")?.[0] === 2 ? [] : opencodeOauthBlockers(authPath))];
    for (const name of ["OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR"]) {
      if (env[name]) blockers.push(`Your shell sets ${name}, which can override the proxy settings. Remove that export, then run setup again.`);
    }
    return { blockers, shellBlockers: [], warnings: [] };
  },
  plan(target) {
    const path = settingsPath();
    const current = readText(path);
    const settings = readSettings(current, path);
    if (v2Settings(settings)) return v2Plan(path, current, settings, target);
    const providers = record(settings.provider, "provider");
    const keyPath = credentialPath(target);
    const keyRef = `{file:${keyPath}}`;
    const fields: Field[] = [];
    const changes: string[] = [];
    const conflicts: string[] = [];
    for (const id of PROVIDERS) {
      const provider = record(providers[id], `provider.${id}`);
      if (provider.npm !== undefined && provider.npm !== `@ai-sdk/${id}`) {
        throw new ConfigError(`provider.${id}.npm selects a custom SDK. Restore the native ${id} SDK, then run setup again.`);
      }
      const options = record(provider.options, `provider.${id}.options`);
      checkModelOverrides(provider.models, `provider.${id}.models`);
      for (const [key, value] of Object.entries({ baseURL: baseUrl(target, id), apiKey: keyRef })) {
        if (options[key] === value) continue;
        if (options[key] !== undefined) conflicts.push(`provider.${id}.options.${key} is set. Setup will replace it.`);
        fields.push({ path: ["provider", id, "options", key], value });
        changes.push(`Configure provider.${id}.options.${key}.`);
      }
      const headers = record(options.headers, `provider.${id}.options.headers`);
      for (const name of Object.keys(headers)) {
        if (!["authorization", "x-api-key"].includes(name.toLowerCase())) continue;
        conflicts.push(`provider.${id}.options.headers.${name} overrides proxy authentication. Setup will remove it.`);
        fields.push({ path: ["provider", id, "options", "headers", name], value: undefined });
        changes.push(`Remove provider.${id}.options.headers.${name}.`);
      }
    }
    const next = edit(current, fields);
    return {
      path, changes, conflicts,
      checkKey: (key) => readText(keyPath).trim() === key,
      apply({ force, key }) {
        assertUnchanged(path, current);
        if (conflicts.length > 0 && !force) throw new ConfigError(`${path} has conflicts. Run setup again with --force to save a backup and replace them.`);
        if (!key) throw new ConfigError("No OpenCode proxy key is available. Run `valet proxy setup opencode` again.");
        const lines = conflicts.length > 0 && existsSync(path) ? [backupSettings(path)] : [];
        writeAtomicText(keyPath, `${key}\n`, true);
        if (changes.length > 0) writeAtomicText(path, next);
        return [...lines, changes.length > 0 ? `Updated ${path}.` : `${path} is already set up.`, "Stored the OpenCode proxy credential in a private file."];
      },
    };
  },
  unapply(target) {
    const path = settingsPath();
    const keyPath = credentialPath(target);
    const keyRef = `{file:${keyPath}}`;
    const current = readText(path);
    const settings = readSettings(current, path);
    if (settings.providers !== undefined) return unapplyV2(path, current, settings, target);
    const providers = record(settings.provider, "provider");
    const fields: Field[] = [];
    const removed: string[] = [];
    const kept: string[] = [];
    for (const id of PROVIDERS) {
      const options = record(record(providers[id], `provider.${id}`).options, `provider.${id}.options`);
      if (options.apiKey !== keyRef) {
        if (options.apiKey !== undefined || options.baseURL !== undefined) kept.push(`provider.${id}.options (setup did not write its credential for this instance)`);
        continue;
      }
      fields.push({ path: ["provider", id, "options", "apiKey"], value: undefined });
      removed.push(`provider.${id}.options.apiKey`);
      if (options.baseURL === baseUrl(target, id)) {
        fields.push({ path: ["provider", id, "options", "baseURL"], value: undefined });
        removed.push(`provider.${id}.options.baseURL`);
      } else if (options.baseURL !== undefined) kept.push(`provider.${id}.options.baseURL (it changed after setup)`);
    }
    const next = edit(current, fields);
    if (fields.length > 0) writeAtomicText(path, next);
    if (!next.includes(keyRef) && existsSync(keyPath)) unlinkSync(keyPath);
    return { path, removed, kept };
  },
  notices: [
    "OpenCode 1.x uses its native Anthropic and OpenAI providers. OpenCode 2.x uses separate Valet provider aliases and preserves native account credentials.",
    "Choose a configured proxy model in `/models`. Other providers, project config, and plugins can use other endpoints.",
  ],
  nextStep: "Start a new `opencode` session to use the Valet proxy.",
};
