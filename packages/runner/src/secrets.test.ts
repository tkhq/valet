import { describe, expect, it } from "vitest";

import { SECRET_RUN_ENV_ALLOWLIST, buildSecretRunEnv } from "./secrets.js";

/**
 * Commands routed through the secrets endpoint must not inherit the runner's
 * own credentials. Previously the child process received a full copy of
 * `process.env`, so any command could read the runner/DO tokens and provider
 * keys straight out of its own environment.
 */
describe("buildSecretRunEnv", () => {
  const ambient = {
    PATH: "/usr/bin:/bin",
    HOME: "/root",
    LANG: "C.UTF-8",
    RUNNER_TOKEN: "runner-token-value",
    JWT_SECRET: "jwt-secret-value",
    GITHUB_TOKEN: "github-token-value",
    OP_SERVICE_ACCOUNT_TOKEN: "op-token-value",
    OPENCODE_SERVER_PASSWORD: "opencode-password",
    ANTHROPIC_API_KEY: "anthropic-key",
  };

  it("passes through allowlisted ambient variables", () => {
    const env = buildSecretRunEnv(ambient, {});
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/root");
    expect(env.LANG).toBe("C.UTF-8");
  });

  it.each([
    "RUNNER_TOKEN",
    "JWT_SECRET",
    "GITHUB_TOKEN",
    "OP_SERVICE_ACCOUNT_TOKEN",
    "OPENCODE_SERVER_PASSWORD",
    "ANTHROPIC_API_KEY",
  ])("does not leak ambient %s", (key) => {
    const env = buildSecretRunEnv(ambient, {});
    expect(env).not.toHaveProperty(key);
  });

  it("injects caller-supplied variables", () => {
    const env = buildSecretRunEnv(ambient, { DB_PASSWORD: "resolved-secret" });
    expect(env.DB_PASSWORD).toBe("resolved-secret");
  });

  it("lets caller-supplied variables override the ambient allowlist", () => {
    const env = buildSecretRunEnv(ambient, { HOME: "/tmp/sandbox" });
    expect(env.HOME).toBe("/tmp/sandbox");
  });

  it("does not resurrect a blocked variable unless the caller asks for it", () => {
    const env = buildSecretRunEnv(ambient, { GITHUB_TOKEN: "caller-provided" });
    expect(env.GITHUB_TOKEN).toBe("caller-provided");
  });

  it("omits allowlisted variables that are unset", () => {
    const env = buildSecretRunEnv({ PATH: "/usr/bin" }, {});
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("only ever emits allowlisted or caller-supplied keys", () => {
    const env = buildSecretRunEnv(ambient, { CUSTOM: "x" });
    const allowed = new Set<string>([...SECRET_RUN_ENV_ALLOWLIST, "CUSTOM"]);
    for (const key of Object.keys(env)) {
      expect(allowed.has(key)).toBe(true);
    }
  });
});
