import { describe, it, expect } from "vitest";
import type { Sandbox, SandboxCapabilities, SandboxProvider } from "../types.js";

export interface SandboxContractContext {
  /** Provision a fresh raw sandbox for one test. Not the PolicySandbox wrapper — this suite exercises providers directly. */
  factory: () => Promise<{ sandbox: Sandbox; cleanup?: () => Promise<void> }>;
  capabilities: SandboxCapabilities;
  /**
   * The provider under test. Only required when capabilities.hibernation is
   * true (drives the suspend/resume round-trip case). When hibernation is
   * false and this is supplied, the suite asserts the provider does NOT expose
   * suspend/resume.
   */
  provider?: SandboxProvider;
  /** Whether the provider makes any effort to honor an abort signal mid-exec. Default true. Virtual sets false. */
  supportsAbort?: boolean;
  /** Selects the command fixtures used by exec-related cases. "full" assumes a real POSIX shell (local/docker); "virtual" is limited to echo/cat/ls/pwd/true/false. Default "full". */
  shell?: "full" | "virtual";
  /**
   * Only required when capabilities.persistentWorkspace is true. Given the
   * sandbox produced by `factory`, destroy it via the provider and recreate
   * a new raw Sandbox bound to the SAME underlying workspace — proves
   * filesystem survival across a provider-level destroy/recreate cycle.
   */
  recreate?: (sandbox: Sandbox) => Promise<{ sandbox: Sandbox; cleanup?: () => Promise<void> }>;
  /**
   * Expected shape of gatewayEndpoint(). Omit to skip the case entirely
   * (existing callers stay byte-identical).
   */
  gatewayEndpoint?: "service-fqdn" | "mapped-port" | "null";
}

export function runSandboxContract(name: string, ctx: SandboxContractContext) {
  const shell = ctx.shell ?? "full";
  const supportsAbort = ctx.supportsAbort ?? true;

  describe(`Sandbox contract: ${name}`, () => {
    async function withSandbox<T>(fn: (sandbox: Sandbox) => Promise<T>): Promise<T> {
      const { sandbox, cleanup } = await ctx.factory();
      try {
        return await fn(sandbox);
      } finally {
        await cleanup?.();
      }
    }

    it("writeFile/readFile round-trips utf8 text", () =>
      withSandbox(async (sb) => {
        await sb.writeFile("note.txt", "hello valet \u{1F680}");
        expect(await sb.readFile("note.txt")).toBe("hello valet \u{1F680}");
      }));

    it("writeBinary/readBinary round-trips arbitrary bytes", () =>
      withSandbox(async (sb) => {
        const bytes = new Uint8Array(256);
        for (let i = 0; i < 256; i++) bytes[i] = i;
        await sb.writeBinary("blob.bin", bytes);
        const out = await sb.readBinary("blob.bin");
        expect(Array.from(out)).toEqual(Array.from(bytes));
      }));

    it("readdir lists created entries", () =>
      withSandbox(async (sb) => {
        await sb.mkdir("rddir");
        await sb.writeFile("rddir/a.txt", "a");
        await sb.writeFile("rddir/b.txt", "b");
        const entries = await sb.readdir("rddir");
        expect([...entries].sort()).toEqual(["a.txt", "b.txt"]);
      }));

    it("stat distinguishes file vs dir and reports file size", () =>
      withSandbox(async (sb) => {
        await sb.mkdir("statdir");
        await sb.writeFile("statdir/file.txt", "12345");
        const fileStat = await sb.stat("statdir/file.txt");
        expect(fileStat.isFile).toBe(true);
        expect(fileStat.isDirectory).toBe(false);
        expect(fileStat.size).toBe(5);
        const dirStat = await sb.stat("statdir");
        expect(dirStat.isDirectory).toBe(true);
        expect(dirStat.isFile).toBe(false);
      }));

    it("mkdir creates nested directories in one call", () =>
      withSandbox(async (sb) => {
        await sb.mkdir("nest/ed/dir");
        await sb.writeFile("nest/ed/dir/leaf.txt", "leaf");
        expect(await sb.readFile("nest/ed/dir/leaf.txt")).toBe("leaf");
      }));

    it("rm with recursive removes a directory tree", () =>
      withSandbox(async (sb) => {
        await sb.mkdir("rmdir/nested");
        await sb.writeFile("rmdir/nested/f.txt", "x");
        await sb.rm("rmdir", { recursive: true });
        await expect(sb.readdir("rmdir")).rejects.toThrow();
      }));

    it("exec separates stdout, stderr, and exitCode", () =>
      withSandbox(async (sb) => {
        if (shell === "virtual") {
          const success = await sb.exec("echo hello");
          expect(success.stdout).toBe("hello\n");
          expect(success.stderr).toBe("");
          expect(success.exitCode).toBe(0);

          const failure = await sb.exec("cat does-not-exist.txt");
          expect(failure.stdout).toBe("");
          expect(failure.stderr.length).toBeGreaterThan(0);
          expect(failure.exitCode).not.toBe(0);
          return;
        }
        const result = await sb.exec("echo out-line; echo err-line 1>&2; exit 3");
        expect(result.stdout).toBe("out-line\n");
        expect(result.stderr).toBe("err-line\n");
        expect(result.exitCode).toBe(3);
      }));

    it("exec honors a cwd override", () =>
      withSandbox(async (sb) => {
        await sb.mkdir("cwd-test");
        await sb.writeFile("cwd-test/marker.txt", "here");
        const r = await sb.exec("cat marker.txt", { cwd: "cwd-test" });
        expect(r.stdout).toBe("here");
        expect(r.exitCode).toBe(0);
      }));

    it("exec injects per-request env vars that don't leak to the next exec", () =>
      withSandbox(async (sb) => {
        if (shell === "virtual") {
          const withEnv = await sb.exec("echo $FOO", { env: { FOO: "bar" } });
          expect(withEnv.stdout).toBe("bar\n");
          const withoutEnv = await sb.exec("echo $FOO");
          expect(withoutEnv.stdout).toBe("\n");
          return;
        }
        const withEnv = await sb.exec("echo $FOO", { env: { FOO: "bar" } });
        expect(withEnv.stdout).toBe("bar\n");
        const withoutEnv = await sb.exec("echo ${FOO:-absent}");
        expect(withoutEnv.stdout).toBe("absent\n");
      }));

    it.skipIf(shell === "virtual")(
      "exec forwards timeout and reports timedOut well under the deadline",
      () =>
        withSandbox(async (sb) => {
          const start = Date.now();
          const r = await sb.exec("sleep 5", { timeout: 200 });
          expect(r.timedOut).toBe(true);
          expect(Date.now() - start).toBeLessThan(2000);
        }),
      10_000,
    );

    it("exec forwards maxOutputBytes and marks the result truncated", () =>
      withSandbox(async (sb) => {
        if (shell === "virtual") {
          const r = await sb.exec(`echo ${"x".repeat(2000)}`, { maxOutputBytes: 100 });
          expect(r.truncated).toBe(true);
          expect(r.stdout.length).toBeLessThanOrEqual(100);
          return;
        }
        const r = await sb.exec("yes x | head -c 100000", { maxOutputBytes: 100 });
        expect(r.truncated).toBe(true);
        expect(r.stdout.length).toBeLessThanOrEqual(100);
      }));

    it.skipIf(!supportsAbort)("exec makes a best-effort abort on signal", () =>
      withSandbox(async (sb) => {
        const controller = new AbortController();
        const start = Date.now();
        const p = sb.exec("sleep 5", { signal: controller.signal });
        setTimeout(() => controller.abort(), 50);
        try {
          await p;
        } catch {
          // Rejection is an acceptable best-effort abort outcome.
        }
        expect(Date.now() - start).toBeLessThan(2000);
      }));

    it("execJob/pollJob deliver output exactly once via advancing offsets", () =>
      withSandbox(async (sb) => {
        if (!sb.execJob || !sb.pollJob || !sb.cancelJob) {
          throw new Error(`${name}: job mode not implemented`);
        }
        const cmd =
          shell === "virtual" ? "echo job-output" : "echo job-output; sleep 0.2; echo more-output";
        const { execId } = await sb.execJob(cmd);

        let offset = 0;
        let combined = "";
        let status: "running" | "done" | "failed" = "running";
        for (let i = 0; i < 200 && status === "running"; i++) {
          const poll = await sb.pollJob(execId, offset);
          combined += poll.output;
          offset = poll.nextOffset;
          status = poll.status;
          if (status === "running") await new Promise((r) => setTimeout(r, 20));
        }
        expect(status).toBe("done");
        expect(combined).toContain("job-output");

        // Re-polling at the final offset must not re-deliver any bytes.
        const after = await sb.pollJob(execId, offset);
        expect(after.output).toBe("");
      }));

    it.skipIf(shell === "virtual")("cancelJob stops a running job", () =>
      withSandbox(async (sb) => {
        if (!sb.execJob || !sb.pollJob || !sb.cancelJob) {
          throw new Error(`${name}: job mode not implemented`);
        }
        const { execId } = await sb.execJob("sleep 5");
        await sb.cancelJob(execId);
        const poll = await sb.pollJob(execId, 0);
        expect(poll.status).not.toBe("running");
      }));

    if (ctx.gatewayEndpoint) {
      it("gatewayEndpoint reflects the provider's reachability model", async () => {
        const { sandbox, cleanup } = await ctx.factory();
        try {
          if (ctx.gatewayEndpoint === "null") {
            // absent method or null return, both acceptable
            const ep = sandbox.gatewayEndpoint ? await sandbox.gatewayEndpoint() : null;
            expect(ep).toBeNull();
          } else {
            if (!sandbox.gatewayEndpoint) throw new Error("expected gatewayEndpoint implemented");
            const ep = await sandbox.gatewayEndpoint();
            expect(ep).not.toBeNull();
            expect(typeof ep?.host).toBe("string");
            expect(ep?.port).toBeGreaterThan(0);
          }
        } finally {
          await cleanup?.();
        }
      });
    }

    if (ctx.capabilities.hibernation) {
      it("suspend + resume round-trips and the sandbox still execs", async () => {
        if (!ctx.provider) {
          throw new Error(`${name}: capabilities.hibernation requires ctx.provider`);
        }
        const provider = ctx.provider;
        if (!provider.suspend || !provider.resume) {
          throw new Error(`${name}: capabilities.hibernation requires provider.suspend/resume`);
        }
        const { sandbox, cleanup } = await ctx.factory();
        try {
          await provider.suspend(sandbox.id);
          await provider.resume(sandbox.id);
          const r = await sandbox.exec("echo alive");
          expect(r.stdout).toContain("alive");
          expect(r.exitCode).toBe(0);
        } finally {
          await cleanup?.();
        }
      });
    } else {
      it("does not expose suspend/resume when hibernation is off", () => {
        // Only assertable when the provider is supplied; the capability being
        // false is the binding contract either way.
        if (ctx.provider) {
          expect(ctx.provider.suspend).toBeUndefined();
          expect(ctx.provider.resume).toBeUndefined();
        }
      });
    }

    if (ctx.capabilities.persistentWorkspace) {
      it("workspace survives a provider-level destroy + recreate", async () => {
        if (!ctx.recreate) {
          throw new Error(`${name}: capabilities.persistentWorkspace requires ctx.recreate`);
        }
        const { sandbox: sb1, cleanup: cleanup1 } = await ctx.factory();
        await sb1.writeFile("survivor.txt", "still here");
        const { sandbox: sb2, cleanup: cleanup2 } = await ctx.recreate(sb1);
        try {
          expect(await sb2.readFile("survivor.txt")).toBe("still here");
        } finally {
          await cleanup2?.();
          await cleanup1?.();
        }
      });
    }
  });
}
