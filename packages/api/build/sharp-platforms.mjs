// Sharp's native addon (`@img/sharp-<platform>`) and libvips
// (`@img/sharp-libvips-<platform>`) are platform-specific. A compiled binary
// must embed the pair for its OWN target, not the build host's, so this module
// stages the pair for every binary target under dist/sharp-native/<platform>/.
//
// By default only the host platform is staged, from the installed packages, so
// a plain `build:assets` needs no network. Set VALET_SHARP_STAGE=all (the release
// workflow does) to stage every target. A package already installed is copied.
// Any other platform is downloaded from the npm registry and verified against
// the integrity hash in pnpm-lock.yaml, so the bytes match a normal install.
//
// Bun's Linux targets are glibc builds (`bun-linux-*`, not `*-musl`), so they
// map to sharp's `linux-*` packages, not `linuxmusl-*`.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const lockfile = resolve(here, "../../../pnpm-lock.yaml");

/** Bun `--compile` target -> sharp platform name. */
export const SHARP_PLATFORM_BY_TARGET = {
  "bun-darwin-arm64": "darwin-arm64",
  "bun-darwin-x64": "darwin-x64",
  "bun-linux-x64": "linux-x64",
  "bun-linux-arm64": "linux-arm64",
};

/** Sharp platform name for a Bun target, or for the host when unset. */
export function sharpPlatformFor(target, sharpEntry) {
  if (target) {
    const platform = SHARP_PLATFORM_BY_TARGET[target];
    if (!platform) throw new Error(`sharp-platforms: no sharp platform for target "${target}"`);
    return platform;
  }
  // Host build: sharp itself knows whether this is glibc or musl.
  const platform = createRequire(sharpEntry ?? createRequire(import.meta.url).resolve("sharp"))("./libvips").runtimePlatformArch();
  // Only the platforms stageSharpNative stages are available. A host such as
  // musl/Alpine (`linuxmusl-*`) would otherwise fail later with a missing package.
  if (!new Set(Object.values(SHARP_PLATFORM_BY_TARGET)).has(platform)) {
    throw new Error(
      `sharp-platforms: unsupported host sharp platform "${platform}"; supported: [${[...new Set(Object.values(SHARP_PLATFORM_BY_TARGET))]}]. Pass --target with one of [${Object.keys(SHARP_PLATFORM_BY_TARGET)}] (Bun's Linux targets are glibc).`,
    );
  }
  return platform;
}

/** The two `@img` package names that make up one sharp platform. */
export function sharpPackagesFor(platform) {
  return [`@img/sharp-${platform}`, `@img/sharp-libvips-${platform}`];
}

function lockIntegrity(name, version) {
  const text = readFileSync(lockfile, "utf8");
  const key = `  '${name}@${version}':\n    resolution: {integrity: `;
  const at = text.indexOf(key);
  if (at === -1) throw new Error(`sharp-platforms: ${name}@${version} not found in pnpm-lock.yaml`);
  const end = text.indexOf("}", at);
  return text.slice(at + key.length, end);
}

function fetchPackage(name, version, dest) {
  const base = name.split("/")[1];
  const url = `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`;
  const res = spawnSync("curl", ["-fsSL", "--retry", "3", "-o", "-", url], { maxBuffer: 256 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`sharp-platforms: download failed: ${url}\n${res.stderr}`);
  const [algo, expected] = lockIntegrity(name, version).split("-");
  const actual = createHash(algo).update(res.stdout).digest("base64");
  if (actual !== expected) throw new Error(`sharp-platforms: integrity mismatch for ${name}@${version}`);
  const tmp = mkdtempSync(resolve(tmpdir(), "sharp-pkg-"));
  try {
    const tgz = resolve(tmp, "pkg.tgz");
    writeFileSync(tgz, res.stdout);
    const x = spawnSync("tar", ["xzf", tgz, "-C", tmp]);
    if (x.status !== 0) throw new Error(`sharp-platforms: tar failed for ${name}: ${x.stderr}`);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(resolve(tmp, "package"), dest, { recursive: true });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Every platform to stage: all supported ones when `all`, else just the host's. */
export function platformsToStage(all, sharpEntry) {
  return all ? [...new Set(Object.values(SHARP_PLATFORM_BY_TARGET))] : [sharpPlatformFor(undefined, sharpEntry)];
}

/** Stage `<outRoot>/<platform>/@img/{sharp-,sharp-libvips-}<platform>`. */
export async function stageSharpNative(outRoot, sharpEntry, { all = process.env.VALET_SHARP_STAGE === "all" } = {}) {
  const sharpRequire = createRequire(sharpEntry);
  const sharpPackage = sharpRequire("../package.json");
  rmSync(outRoot, { recursive: true, force: true });
  for (const platform of platformsToStage(all, sharpEntry)) {
    const [addon, libvips] = sharpPackagesFor(platform);
    const addonDest = resolve(outRoot, platform, addon);
    const libvipsDest = resolve(outRoot, platform, libvips);
    const local = (name) => {
      try {
        return dirname(sharpRequire.resolve(`${name}/package`));
      } catch {
        return undefined;
      }
    };
    const localAddon = local(addon);
    const localLibvips = local(libvips);
    if (localAddon && localLibvips) {
      mkdirSync(dirname(addonDest), { recursive: true });
      cpSync(localAddon, addonDest, { recursive: true });
      cpSync(localLibvips, libvipsDest, { recursive: true });
    } else {
      const wanted = sharpPackage.optionalDependencies[addon];
      fetchPackage(addon, wanted, addonDest);
      const libvipsVersion = JSON.parse(readFileSync(resolve(addonDest, "package.json"), "utf8")).optionalDependencies[libvips];
      fetchPackage(libvips, libvipsVersion, libvipsDest);
    }
    console.log(`sharp-platforms: staged ${platform} (sharp ${sharpPackage.version}) -> ${resolve(outRoot, platform)}`);
  }
}
