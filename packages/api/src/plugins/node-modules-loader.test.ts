import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, copyFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadNodeModulesPlugins } from "./node-modules-loader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "__fixtures__");

async function writePackage(
  root: string,
  pkgName: string,
  opts: { marker?: string; entryContent?: string; entryFile?: string },
): Promise<void> {
  const pkgDir = join(root, pkgName);
  await mkdir(pkgDir, { recursive: true });
  const marker = opts.marker ?? "plugin.mjs";
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: pkgName, version: "0.0.1", valet: { plugin: marker } }, null, 2),
  );
  if (opts.entryContent) {
    await writeFile(join(pkgDir, marker), opts.entryContent);
  } else if (opts.entryFile) {
    await copyFile(opts.entryFile, join(pkgDir, marker));
  }
}

describe("loadNodeModulesPlugins", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "valet-nm-loader-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("loads a valid plugin and quarantines a throwing one", async () => {
    await writePackage(root, "good-plugin", {
      entryContent: `export default {
        name: "good-plugin",
        version: "1.0.0",
        actions: [],
      };\n`,
    });
    await writePackage(root, "bad-plugin", {
      entryContent: `throw new Error("boom during import");\n`,
    });

    const result = await loadNodeModulesPlugins({ searchPaths: [root] });

    expect(result.plugins.map((p) => p.name)).toEqual(["good-plugin"]);
    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0]?.pkg).toBe("bad-plugin");
    expect(result.quarantined[0]?.reason).toMatch(/boom during import/);
  });

  it("skips a denylisted package even though it is otherwise valid", async () => {
    await writePackage(root, "good-plugin", {
      entryContent: `export default { name: "good-plugin", version: "1.0.0" };\n`,
    });

    const result = await loadNodeModulesPlugins({
      searchPaths: [root],
      denylist: ["good-plugin"],
    });

    expect(result.plugins).toEqual([]);
    expect(result.quarantined).toEqual([]);
  });

  it("honors a non-empty allowlist as an only-these filter", async () => {
    await writePackage(root, "allowed-plugin", {
      entryContent: `export default { name: "allowed-plugin", version: "1.0.0" };\n`,
    });
    await writePackage(root, "other-plugin", {
      entryContent: `export default { name: "other-plugin", version: "1.0.0" };\n`,
    });

    const result = await loadNodeModulesPlugins({
      searchPaths: [root],
      allowlist: ["allowed-plugin"],
    });

    expect(result.plugins.map((p) => p.name)).toEqual(["allowed-plugin"]);
  });

  it("quarantines a manifest that fails validateValetPlugin", async () => {
    await writePackage(root, "invalid-plugin", {
      entryContent: `export default { version: "1.0.0" };\n`, // missing name
    });

    const result = await loadNodeModulesPlugins({ searchPaths: [root] });

    expect(result.plugins).toEqual([]);
    expect(result.quarantined[0]?.pkg).toBe("invalid-plugin");
    expect(result.quarantined[0]?.reason).toMatch(/invalid manifest/);
  });

  it("descends one level into @scope/ directories", async () => {
    await writePackage(root, "@scope/plugin-x", {
      entryContent: `export default { name: "scoped-plugin", version: "1.0.0" };\n`,
    });

    const result = await loadNodeModulesPlugins({ searchPaths: [root] });

    expect(result.plugins.map((p) => p.name)).toEqual(["scoped-plugin"]);
  });

  it("supports a factory function default export", async () => {
    await writePackage(root, "factory-plugin", {
      entryContent: `export default async () => ({ name: "factory-plugin", version: "1.0.0" });\n`,
    });

    const result = await loadNodeModulesPlugins({ searchPaths: [root] });

    expect(result.plugins.map((p) => p.name)).toEqual(["factory-plugin"]);
  });

  it("ignores packages with no valet.plugin marker", async () => {
    const pkgDir = join(root, "not-a-plugin");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "not-a-plugin", version: "0.0.1" }, null, 2),
    );

    const result = await loadNodeModulesPlugins({ searchPaths: [root] });

    expect(result.plugins).toEqual([]);
    expect(result.quarantined).toEqual([]);
  });

  it("loads a plugin package reachable only via a symlink (pnpm layout)", async () => {
    // pnpm installs real package contents in a content-addressed store and
    // symlinks them into node_modules. Build the real dir OUTSIDE the
    // scanned search path, then symlink it in, to reproduce that layout.
    const storeRoot = await mkdtemp(join(tmpdir(), "valet-nm-store-"));
    try {
      await writePackage(storeRoot, "symlinked-plugin", {
        entryContent: `export default { name: "symlinked-plugin", version: "1.0.0" };\n`,
      });
      await symlink(
        join(storeRoot, "symlinked-plugin"),
        join(root, "symlinked-plugin"),
        "dir",
      );

      const result = await loadNodeModulesPlugins({ searchPaths: [root] });

      expect(result.quarantined).toEqual([]);
      expect(result.plugins.map((p) => p.name)).toEqual(["symlinked-plugin"]);
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("loads a scoped plugin package reachable only via a symlink (pnpm layout)", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "valet-nm-store-scope-"));
    try {
      await writePackage(storeRoot, "@scope/symlinked-plugin", {
        entryContent: `export default { name: "scoped-symlinked-plugin", version: "1.0.0" };\n`,
      });
      await mkdir(join(root, "@scope"), { recursive: true });
      await symlink(
        join(storeRoot, "@scope", "symlinked-plugin"),
        join(root, "@scope", "symlinked-plugin"),
        "dir",
      );

      const result = await loadNodeModulesPlugins({ searchPaths: [root] });

      expect(result.quarantined).toEqual([]);
      expect(result.plugins.map((p) => p.name)).toEqual(["scoped-symlinked-plugin"]);
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("skips a dangling symlink without throwing or quarantining", async () => {
    await symlink(
      join(root, "does-not-exist"),
      join(root, "dangling-plugin"),
      "dir",
    );

    const result = await loadNodeModulesPlugins({ searchPaths: [root] });

    expect(result.plugins).toEqual([]);
    expect(result.quarantined).toEqual([]);
  });
});

describe("loader parity", () => {
  it("registry-style static import and node_modules loader produce deep-equal summaries", async () => {
    const fixturePath = join(fixturesDir, "sample-plugin.mjs");

    // Registry-style: statically import the fixture module directly (as
    // registry.gen.ts would via a static `import plugin0 from "..."`).
    const registryModule = (await import(pathToFileURL(fixturePath).href)) as {
      default: { name: string; version: string; actions?: Array<{ service: string }> };
    };
    const registrySummary = summarize(registryModule.default);

    // node_modules-style: drop the same fixture into a fixture package dir
    // and load it through the loader.
    const root = await mkdtemp(join(tmpdir(), "valet-nm-parity-"));
    try {
      await writePackage(root, "sample-fixture-pkg", { entryFile: fixturePath });
      const result = await loadNodeModulesPlugins({ searchPaths: [root] });
      expect(result.quarantined).toEqual([]);
      expect(result.plugins).toHaveLength(1);
      const loaderSummary = summarize(result.plugins[0]);

      expect(loaderSummary).toEqual(registrySummary);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function summarize(plugin: { name: string; version: string; actions?: Array<{ service: string }> }) {
  return {
    name: plugin.name,
    version: plugin.version,
    services: (plugin.actions ?? []).map((a) => a.service),
  };
}
