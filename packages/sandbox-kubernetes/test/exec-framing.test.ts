/**
 * Pure unit tests for exec.ts's framing/quoting helpers — no cluster
 * required. `shQuote`'s round-trip tests actually invoke a local `/bin/sh`
 * (present on macOS/Linux dev machines and CI) rather than asserting on the
 * escaped string's literal text, since the whole point of shell quoting is
 * "does the shell parse this back to the original bytes", not "does it look
 * like some particular escaping convention".
 */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildShellCommand,
  execInPod,
  exitCodeFromStatus,
  shQuote,
  wrapAsWorkloadUser,
  type ExecDeps,
  type ExecStatus,
  type PodExecApi,
} from "../src/exec.js";

/** Runs `printf '%s' <quoted>` through a real local shell and returns what
 * it printed — the ground truth for "did shQuote produce something the
 * shell parses back to the original string". */
function roundTripViaShell(value: string): string {
  const result = spawnSync("/bin/sh", ["-c", `printf '%s' ${shQuote(value)}`], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`shell rejected quoted value: ${result.stderr}`);
  }
  return result.stdout;
}

describe("shQuote", () => {
  const cases = [
    "hello",
    "hello world",
    "it's a trap",
    "''''",
    "$(rm -rf /)",
    "`echo pwned`",
    "back\\slash",
    "new\nline",
    "tab\ttab",
    "unicode \u{1F680}",
    "",
    "'",
    "''",
    "a'b'c",
  ];

  it.each(cases)("round-trips %j through a real shell", (value) => {
    expect(roundTripViaShell(value)).toBe(value);
  });

  it("round-trips when applied twice (nested sh -c, as jobs.ts does)", () => {
    const value = "it's got 'quotes' and $(danger)";
    // Level 1: what a nested `sh -c` would see as its raw command string.
    const level1 = `echo $$; exec sh -c ${shQuote(value)}`;
    // Level 2: what the outer `sh -c` sees — quoting level1 as a literal.
    const outerScript = `printf '%s' ${shQuote(level1)}`;
    const result = spawnSync("/bin/sh", ["-c", outerScript], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(level1);
  });
});

describe("buildShellCommand", () => {
  it("passes the command through unchanged with no opts", () => {
    expect(buildShellCommand("echo hi")).toBe("echo hi");
  });

  it("prefixes a cwd change that only applies to this command", () => {
    const built = buildShellCommand("pwd", { cwd: "some dir" });
    expect(built).toContain("cd ");
    expect(built).toContain(shQuote("some dir"));
    expect(built.trim().endsWith("pwd")).toBe(true);
  });

  it("exports env vars ahead of the command", () => {
    const built = buildShellCommand("echo $FOO", { env: { FOO: "bar baz" } });
    expect(built).toContain(`export FOO=${shQuote("bar baz")}`);
  });

  it("rejects env var names that aren't valid shell identifiers", () => {
    expect(() => buildShellCommand("echo", { env: { "not-valid": "x" } })).toThrow();
    expect(() => buildShellCommand("echo", { env: { "1LEADING": "x" } })).toThrow();
  });

  it("actually runs correctly through a real shell: env + cwd + command compose", () => {
    const built = buildShellCommand("echo $FOO-$(pwd | xargs basename)", {
      env: { FOO: "hello" },
      cwd: "/tmp",
    });
    const result = spawnSync("/bin/sh", ["-c", built], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("hello-tmp");
  });
});

const SETPRIV_PREFIX =
  "exec setpriv --reuid dockerd --regid dockerd --init-groups " +
  "env HOME=/home/dockerd USER=dockerd LOGNAME=dockerd /bin/sh -c ";

describe("wrapAsWorkloadUser", () => {
  it("wraps the shell command in the exact setpriv prefix, single-quoted", () => {
    expect(wrapAsWorkloadUser("echo hi")).toBe(`${SETPRIV_PREFIX}${shQuote("echo hi")}`);
  });

  it("the inner command survives single-quote escaping round-trip through a real shell", () => {
    const inner = `printf '%s' 'it'\\''s "quoted"'`;
    const wrapped = wrapAsWorkloadUser(inner);
    // setpriv isn't available on dev machines — strip the identity prefix
    // and run the structurally identical `exec /bin/sh -c '<inner>'` tail,
    // which exercises the exact quoting the wrapper emits.
    expect(wrapped.startsWith(SETPRIV_PREFIX)).toBe(true);
    const runnable = `exec /bin/sh -c ${wrapped.slice(SETPRIV_PREFIX.length)}`;
    const result = spawnSync("/bin/sh", ["-c", runnable], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`it's "quoted"`);
  });
});

/** Fake transport: records the command argv of every exec and reports the
 * given status immediately. */
class FakePodExecApi implements PodExecApi {
  commands: string[][] = [];
  constructor(private status: ExecStatus = { status: "Success" }) {}

  async exec(
    _namespace: string,
    _podName: string,
    _containerName: string,
    command: string[],
    _stdout: unknown,
    _stderr: unknown,
    _stdin: unknown,
    _tty: boolean,
    statusCallback?: (status: ExecStatus) => void,
  ): Promise<{ close(): void }> {
    this.commands.push(command);
    queueMicrotask(() => statusCallback?.(this.status));
    return { close() {} };
  }
}

describe("execInPod workload-user wrapping", () => {
  function deps(docker: boolean): { deps: ExecDeps; api: FakePodExecApi } {
    const api = new FakePodExecApi();
    return { deps: { api, namespace: "ns", containerName: "sandbox", docker }, api };
  }

  it("docker-enabled + non-privileged wraps the command with setpriv", async () => {
    const { deps: d, api } = deps(true);
    const result = await execInPod(d, "pod-1", "echo hi");
    expect(result.exitCode).toBe(0);
    expect(api.commands[0]).toEqual(["/bin/sh", "-c", `${SETPRIV_PREFIX}${shQuote("echo hi")}`]);
  });

  it("docker-enabled + privileged stays unwrapped", async () => {
    const { deps: d, api } = deps(true);
    await execInPod(d, "pod-1", "echo hi", { privileged: true });
    expect(api.commands[0]).toEqual(["/bin/sh", "-c", "echo hi"]);
  });

  it("non-docker sandboxes stay unwrapped either way", async () => {
    const { deps: d, api } = deps(false);
    await execInPod(d, "pod-1", "echo hi");
    await execInPod(d, "pod-1", "echo hi", { privileged: true });
    expect(api.commands).toEqual([
      ["/bin/sh", "-c", "echo hi"],
      ["/bin/sh", "-c", "echo hi"],
    ]);
  });

  it("wraps AFTER env/cwd folding so the whole composed command runs as dockerd", async () => {
    const { deps: d, api } = deps(true);
    await execInPod(d, "pod-1", "pwd", { cwd: "/workspace", env: { FOO: "bar" } });
    const composed = buildShellCommand("pwd", { cwd: "/workspace", env: { FOO: "bar" } });
    expect(api.commands[0]).toEqual(["/bin/sh", "-c", wrapAsWorkloadUser(composed)]);
  });
});

describe("exitCodeFromStatus", () => {
  it("maps Success to 0", () => {
    expect(exitCodeFromStatus({ status: "Success" })).toBe(0);
  });

  it("extracts the ExitCode cause's message as the exit code", () => {
    expect(
      exitCodeFromStatus({
        status: "Failure",
        reason: "NonZeroExitCode",
        details: { causes: [{ reason: "ExitCode", message: "7" }] },
      }),
    ).toBe(7);
  });

  it("extracts exit code 127 (command not found)", () => {
    expect(
      exitCodeFromStatus({
        status: "Failure",
        details: { causes: [{ reason: "ExitCode", message: "127" }] },
      }),
    ).toBe(127);
  });

  it("falls back to 1 for a Failure with no ExitCode cause", () => {
    expect(exitCodeFromStatus({ status: "Failure", reason: "some other reason" })).toBe(1);
  });

  it("falls back to 1 when causes is empty", () => {
    expect(exitCodeFromStatus({ status: "Failure", details: { causes: [] } })).toBe(1);
  });
});
