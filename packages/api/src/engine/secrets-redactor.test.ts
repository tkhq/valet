// @vitest-environment node
/**
 * The output filter of `valet-secrets run`. These tests run the real filter
 * under Node and the real generated script under `sh`, because the bugs that
 * matter here (a value split across writes, a lost exit code) only show up in
 * a running process.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { secretsCliScript } from "./secrets-cli-script.js";
import { REDACTOR_JS } from "./secrets-redactor.js";

const b64 = (value: string) => Buffer.from(value).toString("base64");

function redacted(script: string, secrets: Record<string, string>) {
  const list = Object.entries(secrets)
    .map(([name, value]) => `${name} ${b64(value)}`)
    .join("\n");
  return spawnSync(process.execPath, ["-e", REDACTOR_JS, "--", "sh", "-c", script], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", VALET_SECRETS_REDACT: list },
  });
}

describe("the valet-secrets output filter", () => {
  it("replaces a value on stdout and stderr and keeps the exit code", () => {
    const run = redacted('echo "token=$1-abcdefgh end"; echo "err abcdefgh" >&2; exit 3', { API_KEY: "abcdefgh" });
    expect(run.stdout).toBe("token=-[secret:API_KEY] end\n");
    expect(run.stderr).toBe("err [secret:API_KEY]\n");
    expect(run.status).toBe(3);
  });

  it("finds a value split across two writes", () => {
    const run = redacted("printf 'a sk-live-'; sleep 0.2; printf '1234567 b'", { KEY: "sk-live-1234567" });
    expect(run.stdout).toBe("a [secret:KEY] b");
  });

  it("matches a value saved with a trailing newline when the command prints it without one", () => {
    const run = redacted("printf 'x MULTI\\nLINE-KEY y'", { PEM: "MULTI\nLINE-KEY\n" });
    expect(run.stdout).toBe("x [secret:PEM] y");
  });

  it("prefers the longer of two values that share a start", () => {
    const run = redacted("printf 'abcdefgh123 abcdefgh'", { SHORT: "abcdefgh", LONG: "abcdefgh123" });
    expect(run.stdout).toBe("[secret:LONG] [secret:SHORT]");
  });

  it("leaves a value shorter than 8 bytes alone", () => {
    const run = redacted("printf 'true and false'", { FLAG: "true" });
    expect(run.stdout).toBe("true and false");
  });

  it("does not print the first bytes of a value the output stops inside", () => {
    const run = redacted("printf 'before sk-live-1234'", { KEY: "sk-live-1234567" });
    expect(run.stdout).toBe("before [secret:KEY]");
  });

  it("passes ordinary output through byte for byte", () => {
    const run = redacted("printf 'sk-other\\nsk-live\\n'", { KEY: "sk-live-1234567" });
    expect(run.stdout).toBe("sk-other\nsk-live\n");
  });

  it("keeps its input out of the command's environment", () => {
    const run = redacted('printf "[%s]" "${VALET_SECRETS_REDACT:-}"', { KEY: "abcdefgh" });
    expect(run.stdout).toBe("[]");
  });

  it("reports a missing command with the shell's exit code", () => {
    const run = spawnSync(process.execPath, ["-e", REDACTOR_JS, "--", "no-such-command-xyz"], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", VALET_SECRETS_REDACT: `K ${b64("abcdefgh")}` },
    });
    expect(run.status).toBe(127);
    expect(run.stderr).toContain("no-such-command-xyz: command not found");
  });
});

describe("valet-secrets run", () => {
  it("resolves a reference into the environment and redacts the value from the output", () => {
    const dir = mkdtempSync(join(tmpdir(), "valet-secrets-run-"));
    // A broker that answers every resolve with one value, then the status line.
    writeFileSync(join(dir, "curl"), `#!/bin/sh\nprintf '{"values":["${b64("granola-key-0001")}"]}\\n200'\n`, { mode: 0o755 });
    const cli = join(dir, "valet-secrets");
    writeFileSync(cli, secretsCliScript("http://broker.test"), { mode: 0o755 });
    const run = spawnSync(
      "sh",
      [cli, "run", "--env", "GRANOLA_KEY=secret://personal/granola", "--", "sh", "-c", 'echo "len=${#GRANOLA_KEY} key=$GRANOLA_KEY"'],
      {
        encoding: "utf8",
        env: { PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`, VALET_SANDBOX_TOKEN: "tok" },
      },
    );
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe("len=16 key=[secret:GRANOLA_KEY]\n");
    expect(run.status).toBe(0);
  });
});

describe("encoded copies of a value", () => {
  it("replaces the value printed as base64, base64url, hex, and percent-encoded", () => {
    const value = "sk-live-AB/CD+ef?12";
    const forms = [
      Buffer.from(value).toString("base64"),
      Buffer.from(value).toString("base64url"),
      Buffer.from(value).toString("hex"),
      Buffer.from(value).toString("hex").toUpperCase(),
      encodeURIComponent(value),
    ];
    const run = redacted(`printf '%s\\n' ${forms.map((f) => `'${f}'`).join(" ")}`, { KEY: value });
    expect(run.stdout).toBe("[secret:KEY]\n".repeat(forms.length));
  });
});
