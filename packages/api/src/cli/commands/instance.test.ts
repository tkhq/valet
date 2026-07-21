import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { loadConfig, type ValetConfig } from "../config.js";
import { ExitCode, ProfileNotFoundError } from "../exit.js";
import { parseGlobalFlags } from "../output.js";
import { buildListJson, runInstance } from "./instance.js";

const BASE: ValetConfig = {
  profiles: {
    prod: { url: "http://prod", apiKey: "k_prod" },
    local: { url: "http://localhost:8788" },
  },
  defaultProfile: "prod",
};

let dir: string;
let prevDataDir: string | undefined;
let outSpy: MockInstance;
let errSpy: MockInstance;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "valet-instance-"));
  prevDataDir = process.env.VALET_DATA_DIR;
  process.env.VALET_DATA_DIR = dir;
  outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (prevDataDir === undefined) delete process.env.VALET_DATA_DIR;
  else process.env.VALET_DATA_DIR = prevDataDir;
  rmSync(dir, { recursive: true, force: true });
});

const stdout = (): string => outSpy.mock.calls.map((c) => String(c[0])).join("");

describe("buildListJson", () => {
  it("masks keys to a hasKey boolean and never emits apiKey", () => {
    const json = buildListJson(BASE);
    expect(json).toEqual({
      profiles: {
        prod: { url: "http://prod", hasKey: true },
        local: { url: "http://localhost:8788", hasKey: false },
      },
      defaultProfile: "prod",
    });
    expect(JSON.stringify(json)).not.toContain("k_prod");
  });

  it("omits defaultProfile when unset", () => {
    expect(buildListJson({ profiles: { a: { url: "http://a" } } })).toEqual({
      profiles: { a: { url: "http://a", hasKey: false } },
    });
  });
});

describe("runInstance list", () => {
  it("prints a table with a default marker", () => {
    const code = runInstance(BASE, parseGlobalFlags(["list"]));
    expect(code).toBe(ExitCode.OK);
    const out = stdout();
    expect(out).toContain("prod");
    expect(out).toContain("http://prod");
    // default marker on the prod row.
    expect(out).toMatch(/\*\s+prod/);
    // never leaks the key.
    expect(out).not.toContain("k_prod");
  });

  it("emits masked JSON with --json", () => {
    expect(runInstance(BASE, parseGlobalFlags(["list", "--json"]))).toBe(ExitCode.OK);
    const parsed: unknown = JSON.parse(stdout());
    expect(parsed).toEqual({
      profiles: {
        prod: { url: "http://prod", hasKey: true },
        local: { url: "http://localhost:8788", hasKey: false },
      },
      defaultProfile: "prod",
    });
  });

  it("prints a friendly line when there are no profiles", () => {
    expect(runInstance({}, parseGlobalFlags(["list"]))).toBe(ExitCode.OK);
    expect(stdout()).toContain("no profiles");
  });
});

describe("runInstance use", () => {
  it("sets the default profile and persists it", () => {
    const code = runInstance(BASE, parseGlobalFlags(["use", "local"]));
    expect(code).toBe(ExitCode.OK);
    expect(loadConfig().defaultProfile).toBe("local");
  });

  it("returns Usage for a missing name", () => {
    expect(runInstance(BASE, parseGlobalFlags(["use"]))).toBe(ExitCode.Usage);
  });

  it("throws ProfileNotFoundError (exit 2) for an absent profile", () => {
    let thrown: unknown;
    try {
      runInstance(BASE, parseGlobalFlags(["use", "nope"]));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProfileNotFoundError);
    expect(thrown).toMatchObject({ exitCode: ExitCode.Usage });
    expect(loadConfig()).toEqual({});
  });
});

describe("runInstance unknown subcommand", () => {
  it("returns Usage", () => {
    expect(runInstance(BASE, parseGlobalFlags(["bogus"]))).toBe(ExitCode.Usage);
  });
});
