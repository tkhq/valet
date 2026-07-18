import { describe, expect, it } from "vitest";
import type { ValetConfig } from "./config.js";
import { NoInstanceError, ProfileNotFoundError } from "./exit.js";
import { firstDefined, resolveDataDir, resolveInstance, SERVE_DEFAULTS } from "./resolve.js";

describe("cli/resolve firstDefined", () => {
  it("returns the first non-null/undefined value", () => {
    expect(firstDefined(undefined, null, 3, 4)).toBe(3);
    expect(firstDefined<number>(undefined, null)).toBeUndefined();
    expect(firstDefined(0, 1)).toBe(0); // 0 is defined
  });
});

// Note: serve's port/sandbox precedence lives in resolveServeSettings
// (cli/commands/serve.ts) and is tested in serve.test.ts. resolve.ts owns only
// the shared dataDir + instance resolvers.

describe("cli/resolve resolveDataDir", () => {
  it("flag beats env beats config beats default", () => {
    expect(resolveDataDir({ flag: "/a", env: "/b", config: { dataDir: "/c" } })).toBe("/a");
    expect(resolveDataDir({ env: "/b", config: { dataDir: "/c" } })).toBe("/b");
    expect(resolveDataDir({ config: { dataDir: "/c" } })).toBe("/c");
    expect(resolveDataDir({})).toBe(SERVE_DEFAULTS.dataDir);
  });
});

describe("cli/resolve resolveInstance", () => {
  const config: ValetConfig = {
    profiles: {
      prod: { url: "https://prod", apiKey: "sk-prod" },
      staging: { url: "https://staging" },
    },
    defaultProfile: "staging",
  };

  it("flag beats env beats defaultProfile", () => {
    expect(resolveInstance({ flag: "prod", env: "staging", config })).toEqual({
      name: "prod",
      url: "https://prod",
      apiKey: "sk-prod",
    });
    expect(resolveInstance({ env: "prod", config })).toEqual({
      name: "prod",
      url: "https://prod",
      apiKey: "sk-prod",
    });
    expect(resolveInstance({ config })).toEqual({
      name: "staging",
      url: "https://staging",
      apiKey: undefined,
    });
  });

  it("throws ProfileNotFoundError when the selected name is absent", () => {
    expect(() => resolveInstance({ flag: "nope", config })).toThrow(ProfileNotFoundError);
  });

  it("throws NoInstanceError when nothing selected and no default", () => {
    expect(() => resolveInstance({ config: { profiles: { prod: { url: "https://prod" } } } })).toThrow(
      NoInstanceError,
    );
  });
});
