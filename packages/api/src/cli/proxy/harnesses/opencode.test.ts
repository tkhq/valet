import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "jsonc-parser";
import { harnessAdapter } from "./index.js";
function adapter() { const value = harnessAdapter("opencode"); expect(value, "OpenCode adapter is available").toBeDefined(); if (!value) throw new Error("OpenCode adapter missing"); return value; }

function installV2Catalog(): void {
  const catalog = { data: [
    { id: "catalog-coder", modelID: "upstream-coder", providerID: "openai", type: "chat", package: "@opencode/ai/providers/openai/responses", settings: { apiKey: "never-copy-this", baseURL: "https://direct" }, capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 8192, output: 1024 }, body: { service_tier: "priority", metadata: { origin: "catalog", keep: "source" } }, variants: [{ id: "high", settings: { reasoningEffort: "high", reasoningSummary: "auto", include: ["reasoning.encrypted_content"], apiKey: "never-copy-variant", baseURL: "https://variant-direct" }, headers: { Authorization: "Bearer never-copy-header" } }], enabled: true },
    { id: "catalog-claude", modelID: "upstream-claude", providerID: "anthropic", type: "chat", package: "@opencode/ai/providers/anthropic", capabilities: { tools: true, input: ["text"], output: ["text"] }, enabled: true },
  ] };
  writeFileSync(join(dir, "opencode"), `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '2.2.5\\n'; else printf '%s' '${JSON.stringify(catalog)}'; fi\n`, { mode: 0o755 });
}

const TARGET = { instanceUrl: "https://valet.example", helperCommand: "/bin/valet proxy token opencode --instance work", helperArgs: "proxy token opencode --instance work" };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "valet-opencode-"));
  vi.stubEnv("OPENCODE_CONFIG", join(dir, "opencode.jsonc"));
  vi.stubEnv("VALET_DATA_DIR", dir);
  vi.stubEnv("PATH", dir);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe("OpenCode setup", () => {
  it("preserves JSONC comments, models, and unrelated provider settings while routing both supported providers", () => {
    const path = join(dir, "opencode.jsonc");
    writeFileSync(path, '{\n// keep this comment\n"model":"openai/gpt-custom", "provider":{"openai":{"models":{"gpt-custom":{}},"options":{"timeout":1200}}}, "theme":"dark",\n}\n');
    const plan = adapter().plan(TARGET);
    expect(plan.conflicts).toEqual([]);
    plan.apply({ force: false, key: "vlt-test-secret" });
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain("// keep this comment");
    expect(raw).not.toContain("vlt-test-secret");
    expect(parse(raw)).toMatchObject({ model: "openai/gpt-custom", theme: "dark", provider: {
      openai: { models: { "gpt-custom": {} }, options: { timeout: 1200, baseURL: "https://valet.example/proxy/openai/v1" } },
      anthropic: { options: { baseURL: "https://valet.example/proxy/anthropic/v1" } },
    } });
    const keyRef = parse(raw).provider.openai.options.apiKey as string;
    const keyPath = keyRef.slice(6, -1);
    expect(readFileSync(keyPath, "utf8")).toBe("vlt-test-secret\n");
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(adapter().plan(TARGET).changes).toEqual([]);
    adapter().unapply(TARGET);
    expect(existsSync(keyPath)).toBe(false);
    expect(parse(readFileSync(path, "utf8"))).toMatchObject({ model: "openai/gpt-custom", theme: "dark", provider: { openai: { options: { timeout: 1200 } } } });
  });

  it("refuses conflicting credentials without printing them, backs up on force, and keeps changed values on remove", () => {
    const path = join(dir, "opencode.jsonc");
    const raw = '{"provider":{"anthropic":{"options":{"apiKey":"sk-original","baseURL":"https://other"}}}}';
    writeFileSync(path, raw);
    const plan = adapter().plan(TARGET);
    expect(plan.conflicts.length).toBeGreaterThan(0);
    expect(plan.conflicts.join(" ")).not.toContain("sk-original");
    expect(() => plan.apply({ force: false, key: "vlt-new" })).toThrow();
    plan.apply({ force: true, key: "vlt-new" });
    expect(readFileSync(`${path}.valet-backup`, "utf8")).toBe(raw);
    writeFileSync(path, readFileSync(path, "utf8").replace("https://valet.example/proxy/anthropic/v1", "https://changed"));
    const removed = adapter().unapply(TARGET);
    expect(removed.kept.join(" ")).toContain("anthropic");
    expect(parse(readFileSync(path, "utf8")).provider.anthropic.options.baseURL).toBe("https://changed");
  });

  it("refuses invalid JSONC", () => {
    writeFileSync(join(dir, "opencode.jsonc"), '{"provider":');
    expect(() => adapter().plan(TARGET)).toThrow(/valid/);
  });

  it("rechecks the file after browser approval before writing any secret", () => {
    const plan = adapter().plan(TARGET);
    writeFileSync(plan.path, '{"model":"changed"}');
    expect(() => plan.apply({ force: false, key: "vlt-new" })).toThrow(/changed/);
    expect(readFileSync(plan.path, "utf8")).toBe('{"model":"changed"}');
  });

  it("accepts known versions and refuses legacy saved OAuth that can bypass the configured endpoint", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    vi.stubEnv("PATH", bin);
    writeFileSync(join(bin, "opencode"), '#!/bin/sh\nprintf "2.0.0\\n"\n', { mode: 0o755 });
    expect(adapter().preflight({ XDG_DATA_HOME: dir }).blockers).toEqual([]);
    writeFileSync(join(bin, "opencode"), '#!/bin/sh\nprintf "1.9.0\\n"\n', { mode: 0o755 });
    expect(adapter().preflight({ XDG_DATA_HOME: dir }).blockers).toEqual([]);
    writeFileSync(join(dir, "opencode.jsonc"), '{"providers":{}}');
    expect(() => adapter().plan(TARGET)).toThrow(/OpenCode 2/);
    writeFileSync(join(dir, "opencode.jsonc"), '{}');
    mkdirSync(join(dir, "opencode"));
    writeFileSync(join(dir, "opencode", "auth.json"), '{"openai":{"type":"oauth","access":"secret"},"anthropic":{"type":"api","key":"secret"}}');
    const blockers = adapter().preflight({ XDG_DATA_HOME: dir }).blockers;
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("opencode auth logout");
    expect(blockers[0]).not.toContain("secret");
  });

  it("adds v2 aliases with native catalogs, preserves native auth, and maps the selected custom model", () => {
    installV2Catalog();
    const path = join(dir, "opencode.jsonc");
    writeFileSync(path, '{\n// keep v2 notes\n"model":"openai/coding", "providers":{"openai":{"settings":{"apiKey":"existing-native-key"},"models":{"coding":{"modelID":"gpt-custom"}}}}}\n');
    const plan = adapter().plan(TARGET);
    expect(plan.conflicts).toEqual([]);
    plan.apply({ force: false, key: "vlt-secret" });
    const result = parse(readFileSync(path, "utf8"));
    expect(result.model).toBe("valet-openai/coding");
    expect(result.providers.openai.settings.apiKey).toBe("existing-native-key");
    expect(result.providers["valet-openai"]).toMatchObject({
      canonical: "openai", package: "@opencode/ai/providers/openai", models: { coding: { modelID: "gpt-custom" } },
      settings: { baseURL: "https://valet.example/proxy/openai/v1", transport: "http", encoding: "none" },
    });
    expect(result.providers["valet-anthropic"].canonical).toBe("anthropic");
    expect(adapter().plan(TARGET).changes).toEqual([]);
    adapter().unapply(TARGET);
    const removed = parse(readFileSync(path, "utf8"));
    expect(removed.model).toBe("openai/coding");
    expect(removed.providers.openai.settings.apiKey).toBe("existing-native-key");
    expect(removed.providers["valet-openai"].settings.apiKey).toBeUndefined();
    expect(readFileSync(path, "utf8")).toContain("// keep v2 notes");
  });

  it("refuses per-model endpoints or credentials that would bypass provider routing", () => {
    const path = join(dir, "opencode.jsonc");
    writeFileSync(path, '{"provider":{"openai":{"models":{"custom":{"options":{"baseURL":"https://direct"}}}}}}');
    expect(() => adapter().plan(TARGET)).toThrow(/model override/);
    installV2Catalog();
    writeFileSync(path, '{"providers":{"openai":{"models":{"custom":{"settings":{"encoding":"zstd"}}}}}}');
    expect(() => adapter().plan(TARGET)).toThrow(/model override/);
  });

  it("populates v2 aliases on a fresh config with actual upstream IDs and no catalog credentials", () => {
    installV2Catalog();
    const path = join(dir, "opencode.jsonc");
    writeFileSync(path, '{"providers":{}, "theme":"dark"}');
    const plan = adapter().plan(TARGET);
    plan.apply({ force: false, key: "vlt-dummy" });
    const raw = readFileSync(path, "utf8");
    const result = parse(raw);
    expect(result.providers["valet-openai"].models["catalog-coder"]).toMatchObject({ modelID: "upstream-coder", package: "@opencode/ai/providers/openai/responses", limit: { context: 8192, output: 1024 } });
    expect(result.providers["valet-anthropic"].models["catalog-claude"].modelID).toBe("upstream-claude");
    expect(raw).not.toContain("never-copy-this");
    expect(raw).not.toContain("https://direct");
    expect(result.model).toBeUndefined();
    expect(adapter().plan(TARGET).changes).toEqual([]);
  });

  it("merges partial native model overrides without losing catalog identity or nested defaults", () => {
    installV2Catalog();
    const path = join(dir, "opencode.jsonc");
    writeFileSync(path, JSON.stringify({ model: "openai/catalog-coder", providers: { openai: { models: {
      "catalog-coder": { name: "My model", limit: { output: 512 }, capabilities: { input: ["image"] }, body: { metadata: { origin: "user" } } },
    } } } }));
    adapter().plan(TARGET).apply({ force: false, key: "vlt-dummy" });
    const result = parse(readFileSync(path, "utf8"));
    expect(result.providers["valet-openai"].models["catalog-coder"]).toMatchObject({
      name: "My model", modelID: "upstream-coder", package: "@opencode/ai/providers/openai/responses",
      limit: { context: 8192, output: 512 }, capabilities: { tools: true, input: ["image"], output: ["text"] },
      body: { service_tier: "priority", metadata: { origin: "user", keep: "source" } },
    });
    expect(adapter().plan(TARGET).changes).toEqual([]);
  });

  it("preserves native reasoning variants without copying credentials or endpoints", () => {
    installV2Catalog();
    const path = join(dir, "opencode.jsonc");
    writeFileSync(path, '{"providers":{}}');
    adapter().plan(TARGET).apply({ force: false, key: "vlt-dummy" });
    const raw = readFileSync(path, "utf8");
    const model = parse(raw).providers["valet-openai"].models["catalog-coder"];
    expect(model.variants).toEqual([{ id: "high", settings: { reasoningEffort: "high", reasoningSummary: "auto", include: ["reasoning.encrypted_content"] }, headers: {} }]);
    expect(raw).not.toContain("never-copy-variant");
    expect(raw).not.toContain("never-copy-header");
    expect(raw).not.toContain("https://variant-direct");
  });
});
