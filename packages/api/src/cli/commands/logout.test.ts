import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, saveConfig, type ValetConfig } from "../config.js";
import { ExitCode, ProfileNotFoundError } from "../exit.js";
import { removeProfile, runLogout } from "./logout.js";

const BASE: ValetConfig = {
  profiles: {
    alpha: { url: "http://alpha", apiKey: "k_a" },
    beta: { url: "http://beta" },
    gamma: { url: "http://gamma" },
  },
  defaultProfile: "beta",
};

let dir: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "valet-logout-"));
  prevDataDir = process.env.VALET_DATA_DIR;
  process.env.VALET_DATA_DIR = dir;
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (prevDataDir === undefined) delete process.env.VALET_DATA_DIR;
  else process.env.VALET_DATA_DIR = prevDataDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("removeProfile (pure)", () => {
  it("removes a non-default profile and keeps the default", () => {
    const next = removeProfile(BASE, "alpha");
    expect(next.profiles).toEqual({ beta: { url: "http://beta" }, gamma: { url: "http://gamma" } });
    expect(next.defaultProfile).toBe("beta");
  });

  it("repoints the default to the sorted-first remaining profile", () => {
    const next = removeProfile(BASE, "beta");
    // remaining {alpha, gamma} → sorted first is "alpha".
    expect(next.defaultProfile).toBe("alpha");
    expect(next.profiles).not.toHaveProperty("beta");
  });

  it("clears the default when the last profile is removed", () => {
    const single: ValetConfig = { profiles: { only: { url: "http://only" } }, defaultProfile: "only" };
    const next = removeProfile(single, "only");
    expect(next.profiles).toEqual({});
    expect(next).not.toHaveProperty("defaultProfile");
  });

  it("throws ProfileNotFoundError for an absent profile", () => {
    expect(() => removeProfile(BASE, "nope")).toThrow(ProfileNotFoundError);
  });
});

describe("runLogout", () => {
  it("removes a profile and persists the result", () => {
    const code = runLogout(BASE, "alpha");
    expect(code).toBe(ExitCode.OK);
    const saved = loadConfig();
    expect(saved.profiles).not.toHaveProperty("alpha");
    expect(saved.defaultProfile).toBe("beta");
  });

  it("persists a repointed default", () => {
    expect(runLogout(BASE, "beta")).toBe(ExitCode.OK);
    expect(loadConfig().defaultProfile).toBe("alpha");
  });

  it("returns Usage for a missing name", () => {
    expect(runLogout(BASE, undefined)).toBe(ExitCode.Usage);
  });

  it("throws ProfileNotFoundError (exit 2) for an absent profile and writes nothing", () => {
    // No config written beforehand → loadConfig would be {} if we saved nothing.
    let thrown: unknown;
    try {
      runLogout(BASE, "nope");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProfileNotFoundError);
    expect(thrown).toMatchObject({ exitCode: ExitCode.Usage });
    expect(loadConfig()).toEqual({});
  });
});
