import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs build helper
import { platformsToStage, sharpPlatformFor, sharpPackagesFor, stageSharpNative, SHARP_PLATFORM_BY_TARGET } from "../build/sharp-platforms.mjs";

const sharpEntry = createRequire(import.meta.url).resolve("sharp");
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("sharp platform staging", () => {
  it("maps each Bun target to glibc/darwin sharp packages", () => {
    expect(sharpPlatformFor("bun-linux-arm64")).toBe("linux-arm64");
    expect(sharpPlatformFor("bun-darwin-x64")).toBe("darwin-x64");
    expect(() => sharpPlatformFor("bun-linux-x64-musl")).toThrow(/no sharp platform/);
    expect(sharpPackagesFor("linux-x64")).toEqual(["@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64"]);
  });

  it("stages only the host platform by default, with no network", () => {
    const host = sharpPlatformFor(undefined, sharpEntry);
    expect(platformsToStage(false, sharpEntry)).toEqual([host]);
    expect(platformsToStage(true, sharpEntry).sort()).toEqual([...new Set(Object.values(SHARP_PLATFORM_BY_TARGET))].sort());
  });

  it("copies the installed host packages without downloading", async () => {
    const out = mkdtempSync(resolve(tmpdir(), "sharp-stage-"));
    dirs.push(out);
    await stageSharpNative(out, sharpEntry, { all: false });
    const host = sharpPlatformFor(undefined, sharpEntry);
    for (const pkg of sharpPackagesFor(host)) expect(existsSync(resolve(out, host, pkg, "package.json"))).toBe(true);
    for (const other of new Set(Object.values(SHARP_PLATFORM_BY_TARGET) as string[])) {
      if (other !== host) expect(existsSync(resolve(out, other))).toBe(false);
    }
  });
});
