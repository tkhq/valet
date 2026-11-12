import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../../exit.js";

type Settings = Record<string, unknown>;
export interface OpenCodeCatalog { openai: Settings; anthropic: Settings }

function isRecord(value: unknown): value is Settings {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Variant controls can contain effective connection fields in the model API. */
function safeVariantMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeVariantMetadata);
  if (!isRecord(value)) return value;
  const connectionFields = ["apikey", "api_key", "authorization", "x-api-key", "api-key", "x-auth-token", "token", "access_token", "refresh_token", "credential", "credentials", "auth", "authentication", "baseurl", "base_url", "env_key", "transport", "encoding", "package", "npm"];
  return Object.fromEntries(Object.entries(value)
    .filter(([name]) => !connectionFields.includes(name.toLowerCase()))
    .map(([name, item]) => [name, safeVariantMetadata(item)]));
}

/** The local model API includes effective credentials. Copy only model metadata. */
function parseCatalog(raw: string): OpenCodeCatalog {
  const catalog: OpenCodeCatalog = { openai: {}, anthropic: {} };
  let response: unknown;
  try { response = JSON.parse(raw); } catch { throw new Error("invalid model catalog JSON"); }
  if (!isRecord(response) || !Array.isArray(response.data)) throw new Error("missing model catalog data");
  for (const entry of response.data) {
    if (!isRecord(entry) || (entry.providerID !== "openai" && entry.providerID !== "anthropic")) continue;
    if (typeof entry.id !== "string" || !entry.id || typeof entry.modelID !== "string") continue;
    if (entry.type !== "chat" || entry.enabled === false) continue;
    const allowedPackages = [`@opencode/ai/providers/${entry.providerID}`, `@opencode/ai/providers/${entry.providerID}/responses`, `@opencode/ai/providers/${entry.providerID}/chat`];
    if (typeof entry.package !== "string" || !allowedPackages.includes(entry.package)) continue;
    const model: Settings = { modelID: entry.modelID };
    for (const name of ["name", "family", "type", "package", "capabilities", "compatibility", "limit", "body"]) {
      if (entry[name] !== undefined) model[name] = entry[name];
    }
    if (Array.isArray(entry.variants)) {
      model.variants = entry.variants.filter(isRecord).filter((variant) => typeof variant.id === "string").map((variant) => {
        const fields = Object.fromEntries(["id", "name", "description", "settings", "headers", "body"]
          .filter((name) => variant[name] !== undefined).map((name) => [name, variant[name]]));
        return safeVariantMetadata(fields);
      });
    }
    catalog[entry.providerID][entry.id] = model;
  }
  if (Object.keys(catalog.openai).length === 0 || Object.keys(catalog.anthropic).length === 0) throw new Error("missing native model catalogs");
  return catalog;
}

/** Discover real model IDs without opening the person's config or account database. */
export function discoverOpenCodeCatalog(): OpenCodeCatalog {
  const dir = mkdtempSync(join(tmpdir(), "valet-opencode-catalog-"));
  try {
    const home = join(dir, "home");
    mkdirSync(home);
    const path = join(dir, "opencode.json");
    const settings = { apiKey: "valet-catalog-placeholder", baseURL: "http://127.0.0.1:9/v1" };
    writeFileSync(path, JSON.stringify({ providers: { openai: { settings }, anthropic: { settings } } }), { mode: 0o600 });
    const raw = execFileSync("opencode", ["api", "get", "/api/model", "--standalone"], {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: join(dir, "config"),
        XDG_DATA_HOME: join(dir, "data"),
        XDG_CACHE_HOME: join(dir, "cache"),
        OPENCODE_CONFIG: path,
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
        DO_NOT_TRACK: "1",
        CI: "true",
      },
      encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseCatalog(raw);
  } catch {
    throw new ConfigError("Could not read OpenCode's native model catalog. Check `opencode api get /api/model --standalone`, then run setup again.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
