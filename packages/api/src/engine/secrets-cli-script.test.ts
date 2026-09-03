import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandWrapperScript, secretsCliScript } from "./secrets-cli-script.js";

// The constant is generated from a shell source with two placeholders. A
// regeneration from an already-substituted copy once baked a probe host into
// every sandbox, and the CLI failed with "Could not resolve host".
describe("secretsCliScript", () => {
  it("bakes in the api url it is given and nothing else", () => {
    const out = secretsCliScript("http://host.docker.internal:8788");
    expect(out).toContain('API="http://host.docker.internal:8788"');
    expect(out).not.toContain("__VALET_API_URL__");
    expect(out).not.toContain("__TOKEN_READ__");
    expect(out).not.toMatch(/http:\/\/api:|127\.0\.0\.1:8\d{3}|localhost:8\d{3}/);
  });

  it("reads the token from the creds mount, then the environment", () => {
    const out = secretsCliScript("http://x:1");
    expect(out).toContain("tok=$(cat /etc/valet/creds/token 2>/dev/null)");
    expect(out).toContain('[ -n "$tok" ] || tok=${VALET_SANDBOX_TOKEN:-}');
    expect(out).toContain("unset VALET_SANDBOX_TOKEN");
  });
});

/**
 * The generated wrapper is shell, so these run it rather than grep it. A
 * `set -n` parse and a real execution catch the quoting bugs a substring
 * assertion never would.
 */
describe("commandWrapperScript", () => {
  const write = (body: string): string => {
    const file = join(mkdtempSync(join(tmpdir(), "valet-wrap-")), "w.sh");
    writeFileSync(file, body, { mode: 0o755 });
    return file;
  };

  it("parses as POSIX shell in both forms", () => {
    for (const cmd of [
      { command: "stripe", env: "STRIPE_API_KEY", reference: "op://Eng/Stripe/secret key" },
      { command: "aws", env: "AWS_SECRET_ACCESS_KEY", credential: "aws" },
    ]) {
      const file = write(commandWrapperScript(cmd));
      const parsed = spawnSync("sh", ["-n", file], { encoding: "utf8" });
      expect(parsed.status, `${cmd.command}: ${parsed.stderr}`).toBe(0);
    }
  });

  // A vault name with an apostrophe closed the single-quoted reference and
  // the rest of the line became shell. The escape has to survive a parse.
  it("survives a quote in the reference", () => {
    const file = write(
      commandWrapperScript({ command: "c", env: "A", reference: "op://Ahmed's Vault/Item/field" }),
    );
    expect(spawnSync("sh", ["-n", file], { encoding: "utf8" }).status).toBe(0);
  });

  it("reports a missing real binary rather than looping on itself", () => {
    const file = write(commandWrapperScript({ command: "nope-xyz", env: "A", reference: "op://v/i/f" }));
    const run = spawnSync("sh", [file], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    expect(run.status).toBe(127);
    expect(run.stderr).toContain("not installed in this sandbox image");
  });

  // The wrapper supplies a credential where there is none; it never overrides
  // one the caller set. `true` stands in for the real binary.
  it("execs the real command untouched when the variable is already set", () => {
    const dir = mkdtempSync(join(tmpdir(), "valet-bin-"));
    writeFileSync(join(dir, "true2"), "#!/bin/sh\necho ran-real\n", { mode: 0o755 });
    const file = write(commandWrapperScript({ command: "true2", env: "A", reference: "op://v/i/f" }));
    const run = spawnSync("sh", [file], {
      encoding: "utf8",
      env: { PATH: `${dir}:/usr/bin:/bin`, A: "already-set" },
    });
    expect(run.stdout.trim()).toBe("ran-real");
    expect(run.status).toBe(0);
  });
});
