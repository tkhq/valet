import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readdir, rm, readFile, stat, writeFile, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { omittedMarker, SandboxGoneError } from "@valet/engine";
import { DockerSandboxProvider, type DockerSandboxCreateOpts, createSandboxWorkspace } from "../src/index.js";
import { dropFinishedDetachedOutputs, jobOutputLimit, sliceUtf8 } from "../src/sandbox.js";
import { buildFullProfileTestImage } from "./full-profile-test-image.js";

/** Skip the whole suite when Docker isn't available locally. */
function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    stdio: "pipe",
  });
  return r.status === 0;
}

const dockerHere = dockerAvailable();
const describeDocker = dockerHere ? describe : describe.skip;

let tmp: string;
let provider: DockerSandboxProvider;

describeDocker("DockerSandbox", () => {
  beforeAll(() => {
    if (!dockerHere) {
      // eslint-disable-next-line no-console
      console.warn("docker not available — DockerSandbox tests skipped");
    }
  });

  beforeEach(async () => {
    tmp = await createSandboxWorkspace("valet-docker-");
    provider = new DockerSandboxProvider();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function makeSandbox(extra: Partial<DockerSandboxCreateOpts> = {}) {
    return (await provider.create({
      workspace: tmp,
      // Use the smallest possible image to keep CI cold-start fast.
      image: "alpine:3.20",
      ...extra,
    })) as InstanceType<typeof import("../src/index.js").DockerSandbox>;
  }

  it("create + destroy lifecycle works", async () => {
    const sb = await makeSandbox();
    expect(sb.id.startsWith("dsb-")).toBe(true);
    expect(sb.containerId.length).toBeGreaterThan(8);
    const status = await provider.status(sb.id);
    expect(status.state).toBe("ready");
    await provider.destroy(sb.id);
    const stopped = await provider.status(sb.id);
    expect(stopped.state).toBe("released");
  });

  it("proves the bind mount before returning, and leaves no probe file behind", async () => {
    // create() confirms the container reads the directory the host writes
    // to. A daemon in a VM mounts an empty directory when it does not share
    // the path, which used to surface much later as a "cp: can't stat" from
    // workspace prep. The probe must also clean up after itself — the agent
    // sees this directory.
    const sb = await makeSandbox();
    try {
      expect(await readdir(tmp)).toEqual([]);
      await sb.writeFile("staged.txt", "from host");
      const inside = await sb.exec("cat /workspace/staged.txt");
      expect(inside.exitCode).toBe(0);
      expect(inside.stdout).toBe("from host");
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("filesystem ops execute against the host bind-mount", async () => {
    const sb = await makeSandbox();
    try {
      await sb.writeFile("note.txt", "hello from host");
      // The file is visible on the host because of the bind mount.
      expect(await readFile(join(tmp, "note.txt"), "utf8")).toBe("hello from host");
      // …and visible from inside the container too.
      const inside = await sb.exec("cat /workspace/note.txt");
      expect(inside.exitCode).toBe(0);
      expect(inside.stdout).toBe("hello from host");
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("FS ops accept container paths (e.g. /workspace/foo)", async () => {
    // The agent often shells out via bash (which sees /workspace) and then
    // tries to read the file back via the FS tools. The container path
    // should resolve to the same host file as a relative path.
    const sb = await makeSandbox();
    try {
      const r = await sb.exec("echo container-write > /workspace/from-bash.txt");
      expect(r.exitCode).toBe(0);
      expect(await sb.readFile("/workspace/from-bash.txt")).toBe("container-write\n");
      expect(await sb.readFile("from-bash.txt")).toBe("container-write\n");

      await sb.writeFile("/workspace/from-fs.txt", "fs-write");
      expect(await readFile(join(tmp, "from-fs.txt"), "utf8")).toBe("fs-write");
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("exec runs commands inside the container", async () => {
    const sb = await makeSandbox();
    try {
      const r = await sb.exec("uname -s && hostname");
      expect(r.exitCode).toBe(0);
      // alpine's uname says "Linux"; the host (this test process) runs darwin.
      expect(r.stdout).toContain("Linux");
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("default cwd is the bind-mounted workspace", async () => {
    const sb = await makeSandbox();
    try {
      await writeFile(join(tmp, "marker"), "");
      const r = await sb.exec("ls");
      expect(r.stdout).toContain("marker");
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("non-zero exit codes propagate", async () => {
    const sb = await makeSandbox();
    try {
      const r = await sb.exec("false");
      expect(r.exitCode).not.toBe(0);
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("exec against a removed container rejects instead of resolving a normal ExecResult", async () => {
    const sb = await makeSandbox();
    // Remove the container out from under the sandbox handle, then try to
    // exec against it. `docker exec` on a gone container fails at the
    // docker-CLI level ("No such container") with a non-zero exit — that
    // must surface as a rejection (transport failure) so PolicySandbox's
    // degradation path fires, not as a normal ExecResult with a non-zero
    // exitCode (which would be indistinguishable from the user's command
    // itself failing).
    await provider.destroy(sb.id);
    await expect(sb.exec("echo hi")).rejects.toThrow(/No such container|is not running/i);
  });

  it("a command whose OWN stderr matches the container-death regex (e.g. curl 'Connection refused') resolves normally in a live container", async () => {
    // CONTAINER_DEATH_PATTERN includes /Connection refused/i and
    // /is not running/i, which are also plausible things for a user's own
    // command to print on stderr (e.g. curl hitting a closed port). A
    // regex match alone must not be treated as transport failure — the
    // liveness check (isContainerAlive) has to confirm real death first.
    const sb = await makeSandbox();
    try {
      const r = await sb.exec(
        'sh -c \'echo "curl: (7) Failed to connect: Connection refused" >&2; exit 7\'',
      );
      expect(r.exitCode).toBe(7);
      expect(r.stderr).toContain("Connection refused");
      // Container must still be alive — this was never a transport failure.
      const status = await provider.status(sb.id);
      expect(status.state).toBe("ready");
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("job-mode: a job whose OWN stderr matches the container-death regex completes normally, container stays alive", async () => {
    const sb = await makeSandbox();
    try {
      const { execId } = await sb.execJob(
        'sh -c \'echo "curl: (7) Failed to connect: Connection refused" >&2; exit 7\'',
      );
      let offset = 0;
      let poll = await sb.pollJob(execId, offset);
      for (let i = 0; i < 100 && poll.status === "running"; i++) {
        offset = poll.nextOffset;
        await new Promise((r) => setTimeout(r, 50));
        poll = await sb.pollJob(execId, offset);
      }
      expect(poll.status).toBe("done");
      expect(poll.exitCode).toBe(7);
      const status = await provider.status(sb.id);
      expect(status.state).toBe("ready");
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("job-mode: execJob/pollJob round-trips output and exitCode", async () => {
    const sb = await makeSandbox();
    try {
      const { execId } = await sb.execJob("echo hello");
      let offset = 0;
      let output = "";
      let poll = await sb.pollJob(execId, offset);
      while (poll.status === "running") {
        output += poll.output;
        offset = poll.nextOffset;
        await new Promise((r) => setTimeout(r, 50));
        poll = await sb.pollJob(execId, offset);
      }
      output += poll.output;
      expect(poll.status).toBe("done");
      expect(poll.exitCode).toBe(0);
      expect(output).toContain("hello");
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("job-mode: exec ids are unique per job and a requested id is used as given (fix wave 2, B1)", async () => {
    const sb = await makeSandbox();
    try {
      const a = await sb.execJob("true");
      const b = await sb.execJob("true");
      expect(a.execId).toMatch(/^job-[0-9a-z]+-[0-9a-z]{8}$/);
      expect(a.execId).not.toBe(b.execId);
      await expect(sb.execJob("true", { execId: "job-abc-12345678" })).resolves.toEqual({ execId: "job-abc-12345678" });
    } finally {
      await provider.destroy(sb.id);
    }
  });

  async function pollUntilDone(sb: { pollJob(id: string, o: number, opts?: { maxBytes?: number; tail?: boolean }): Promise<{ status: string }> }, execId: string, opts: { maxBytes?: number; tail?: boolean }) {
    let poll = await sb.pollJob(execId, 0, opts);
    for (let i = 0; i < 100 && poll.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      poll = await sb.pollJob(execId, 0, opts);
    }
    return poll;
  }

  it("job-mode: a terminal poll of a detached job keeps its state for later reads (fix wave 2, H1)", async () => {
    const sb = await makeSandbox();
    try {
      const { execId } = await sb.execJob("printf 'line one\\nline two\\n'; exit 3", { detached: true });
      // The watcher's tail read sees the exit first.
      const watcherRead = await pollUntilDone(sb, execId, { maxBytes: 4096, tail: true });
      expect(watcherRead).toMatchObject({ status: "done", exitCode: 3 });
      // A later process_read still gets the whole log and the exit.
      const agentRead = await sb.pollJob(execId, 0, { maxBytes: 4096 });
      expect(agentRead).toMatchObject({ status: "done", exitCode: 3, output: "line one\nline two\n" });
      // And the watcher's next poll does not turn the clean exit into a lost job.
      expect(await sb.pollJob(execId, 0, { maxBytes: 4096, tail: true })).toMatchObject({ status: "done", exitCode: 3 });
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("job-mode: bounds a detached job's in-memory output (fix wave 2, H2)", async () => {
    const sb = await makeSandbox();
    try {
      const { execId } = await sb.execJob("head -c 20000 /dev/zero | tr '\\0' 'a'", { detached: true, maxOutputBytes: 1000 });
      const poll = await pollUntilDone(sb, execId, { maxBytes: 100_000 });
      expect(poll).toMatchObject({ status: "done", truncated: true });
      const full = await sb.pollJob(execId, 0, { maxBytes: 100_000 });
      expect(Buffer.byteLength(full.output)).toBeLessThan(2000);
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("job-mode: offsets count UTF-8 bytes, like the kubernetes provider (fix wave 2, L4)", async () => {
    const sb = await makeSandbox();
    try {
      const { execId } = await sb.execJob("printf '\\303\\251\\342\\234\\223\\nx\\n'", { detached: true });
      await pollUntilDone(sb, execId, { maxBytes: 4096, tail: true });
      // "é" is 2 bytes and "✓" is 3. A 4-byte read stops before the split "✓".
      const first = await sb.pollJob(execId, 0, { maxBytes: 4 });
      expect(first).toMatchObject({ status: "running", output: "é", nextOffset: 2 });
      const rest = await sb.pollJob(execId, 2, { maxBytes: 4096 });
      expect(rest).toMatchObject({ status: "done", output: "✓\nx\n", nextOffset: 8 });
      const tail = await sb.pollJob(execId, 0, { maxBytes: 4, tail: true });
      expect(tail).toMatchObject({ output: "\nx\n", nextOffset: 8 });
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("restore of a released sandbox throws SandboxGoneError (fix wave 2, M2)", async () => {
    const sb = await makeSandbox();
    await provider.destroy(sb.id);
    await expect(provider.restore(sb.id)).rejects.toBeInstanceOf(SandboxGoneError);
  });

  it("job-mode: pollJob bounds a forward read and a tail read (spec B4)", async () => {
    const sb = await makeSandbox();
    try {
      const { execId } = await sb.execJob("printf 0123456789", { detached: true });
      // Wait until the job finished, reading only the tail so nothing is evicted.
      let tailPoll = await sb.pollJob(execId, 0, { maxBytes: 3, tail: true });
      for (let i = 0; i < 100 && tailPoll.status === "running"; i++) {
        await new Promise((r) => setTimeout(r, 50));
        tailPoll = await sb.pollJob(execId, 0, { maxBytes: 3, tail: true });
      }
      // A finished job is evicted after a terminal poll, so the forward
      // checks use a second job.
      expect(tailPoll).toMatchObject({ status: "done", exitCode: 0, output: "789", nextOffset: 10 });

      const second = await sb.execJob("printf 0123456789", { detached: true });
      let first = await sb.pollJob(second.execId, 0, { maxBytes: 4 });
      for (let i = 0; i < 100 && first.output.length < 4; i++) {
        await new Promise((r) => setTimeout(r, 50));
        first = await sb.pollJob(second.execId, 0, { maxBytes: 4 });
      }
      expect(first).toMatchObject({ status: "running", output: "0123", nextOffset: 4 });
      let rest = await sb.pollJob(second.execId, 4, { maxBytes: 100 });
      for (let i = 0; i < 100 && rest.status === "running"; i++) {
        await new Promise((r) => setTimeout(r, 50));
        rest = await sb.pollJob(second.execId, 4, { maxBytes: 100 });
      }
      expect(rest).toMatchObject({ status: "done", exitCode: 0, output: "456789", nextOffset: 10 });
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("job-mode: execJob against an already-removed container rejects on poll (transport failure, not a normal terminal poll)", async () => {
    const sb = await makeSandbox();
    // Remove the container before kicking off the job — execJob is
    // fire-and-forget (it doesn't await the spawned docker exec), so the
    // "No such container" failure only surfaces once the detached process
    // closes and pollJob observes it. That must reject, not resolve with
    // a normal terminal JobPoll.
    await provider.destroy(sb.id);
    const { execId } = await sb.execJob("echo hi");

    let rejected = false;
    for (let i = 0; i < 100 && !rejected; i++) {
      try {
        await sb.pollJob(execId, 0);
      } catch (err) {
        rejected = true;
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/No such container|is not running/i);
      }
      if (!rejected) await new Promise((r) => setTimeout(r, 50));
    }
    expect(rejected).toBe(true);
  });

  it("times out long-running commands", async () => {
    const sb = await makeSandbox();
    try {
      const r = await sb.exec("sleep 10", { timeout: 500 });
      expect(r.timedOut).toBe(true);
      expect(r.exitCode).not.toBe(0);
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("aborts via signal", async () => {
    const sb = await makeSandbox();
    try {
      const ac = new AbortController();
      const promise = sb.exec("sleep 10", { signal: ac.signal });
      setTimeout(() => ac.abort(), 200);
      const r = await promise;
      expect(r.exitCode).not.toBe(0);
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("caps stdout at maxOutputBytes, keeping head and tail with an omission marker", async () => {
    const sb = await makeSandbox();
    try {
      // Print HEAD + 50_000 x's + TAIL; cap at 1_000 → head 250, tail 750.
      const r = await sb.exec(
        "printf 'HEAD'; printf 'x%.0s' $(seq 1 50000); printf 'TAIL'",
        { maxOutputBytes: 1_000 },
      );
      // The in-band omission marker adds a bounded overhead beyond the cap.
      expect(r.stdout.length).toBeLessThanOrEqual(1_100);
      expect(r.stdout.startsWith("HEAD")).toBe(true);
      expect(r.stdout).toContain("bytes omitted");
      expect(r.stdout.endsWith("TAIL")).toBe(true);
      expect(r.truncated).toBe(true);
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("applies a zero-byte cap to sync and job output", async () => {
    const sb = await makeSandbox();
    try {
      const sync = await sb.exec("printf x", { maxOutputBytes: 0 });
      expect(sync.stdout).toBe(omittedMarker(1));
      expect(sync.truncated).toBe(true);

      const { execId } = await sb.execJob("printf x", { maxOutputBytes: 0 });
      let poll = await sb.pollJob(execId, 0);
      let output = poll.output;
      let truncated = poll.truncated === true;
      while (poll.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, 20));
        poll = await sb.pollJob(execId, poll.nextOffset);
        output += poll.output;
        if (poll.truncated) truncated = true;
      }
      expect(output).toBe(omittedMarker(1));
      expect(truncated).toBe(true);
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("pipes stdin into the child process", async () => {
    const sb = await makeSandbox();
    try {
      const r = await sb.exec("cat", { stdin: "piped-input\n" });
      expect(r.stdout).toBe("piped-input\n");
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("merges per-call env over container env", async () => {
    const sb = await makeSandbox();
    try {
      const r = await sb.exec("echo $VALET_TEST_VAR", {
        env: { VALET_TEST_VAR: "from-test" },
      });
      expect(r.stdout.trim()).toBe("from-test");
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("resolves symlinked workspace paths (e.g. /tmp on macOS)", async () => {
    // Without symlink resolution, Docker Desktop on macOS silently maps the
    // bind mount to a different path than node:fs sees, so writes through
    // the container never appear on the host (and vice versa).
    const real = await mkdtemp(join(tmp, "real-"));
    const link = join(tmp, "linked");
    await symlink(real, link);
    const sb = await provider.create({ workspace: link, image: "alpine:3.20" });
    try {
      await (sb as InstanceType<typeof import("../src/index.js").DockerSandbox>).exec(
        "echo from-container > /workspace/marker.txt",
      );
      // Visible on the *real* host path, even though we passed the symlink.
      expect(await readFile(join(real, "marker.txt"), "utf8")).toBe(
        "from-container\n",
      );
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("rejects when workspace is missing or not a directory", async () => {
    // Cast to bypass the type guard — runtime validation is the contract.
    await expect(
      provider.create({} as DockerSandboxCreateOpts),
    ).rejects.toThrow(/working directory is required/);
    const file = join(tmp, "not-a-dir.txt");
    await writeFile(file, "x");
    await expect(provider.create({ workspace: file })).rejects.toThrow(/not a directory/);
  });

  it("backend is 'docker'", () => {
    expect(provider.backend).toBe("docker");
  });

  it("capabilities() returns the decision-1 docker values", () => {
    expect(provider.capabilities()).toEqual({
      snapshot: "filesystem",
      persistentWorkspace: true,
      tunnels: false,
      warmPool: false,
      hibernation: false,
      customImage: true,
      isolated: true,
      coldStartEstimateMs: 8000,
      browserAutomation: false,
      browserViewer: false,
      credsMount: true,
      dockerSupport: true,
      nestedKubernetes: false,
    });
  });

  it("status() of a live container is 'ready', of an absent one is 'released'", async () => {
    const sb = await provider.create({ workspace: tmp });
    try {
      expect((await provider.status(sb.id)).state).toBe("ready");
    } finally {
      await provider.destroy(sb.id);
    }
    expect((await provider.status(sb.id)).state).toBe("released");
    expect((await provider.status("does-not-exist")).state).toBe("released");
  });

  it("gatewayEndpoint() returns null for a headless (profile omitted) container", async () => {
    const sb = await makeSandbox();
    try {
      await expect(sb.gatewayEndpoint()).resolves.toBeNull();
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("gatewayEndpoint() returns a mapped loopback port for a full-profile container", async () => {
    // profile:"full" now runs /bin/bash /start-full.sh when present, else
    // degrades to the tail placeholder (see buildDockerRunArgs) — alpine:3.20
    // has neither, so this needs the bash+script fixture image to exercise
    // the gateway-serving path.
    const image = await buildFullProfileTestImage();
    const sb = await makeSandbox({ profile: "full", image });
    try {
      const ep = await sb.gatewayEndpoint();
      expect(ep).not.toBeNull();
      expect(ep?.host).toBe("127.0.0.1");
      expect(ep?.port).toBeGreaterThan(0);
      expect(ep?.port).not.toBe(9000); // ephemeral, not the fixed in-container port
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("gatewayEndpoint() returns null after the container is destroyed", async () => {
    const image = await buildFullProfileTestImage();
    const sb = await makeSandbox({ profile: "full", image });
    await provider.destroy(sb.id);
    await expect(sb.gatewayEndpoint()).resolves.toBeNull();
  });

  it("credsFiles: create mounts creds, updateCreds propagates immediately, destroy removes host dir", async () => {
    const sb = await makeSandbox({ credsFiles: { token: "aaa" } });
    const sbId = sb.id;
    // credsHostDir is keyed by containerName (includes timestamp) — use the
    // stored path from the sandbox itself rather than reconstructing it.
    const credsDir = sb.credsHostDir!;
    expect(credsDir).toBeTruthy();
    try {
      // Initial creds visible in the container.
      const first = await sb.exec("cat /etc/valet/creds/token");
      expect(first.exitCode).toBe(0);
      expect(first.stdout.trim()).toBe("aaa");

      // updateCreds rewrites the host file; the bind mount is instant.
      await provider.updateCreds(sbId, { token: "bbb" });
      const second = await sb.exec("cat /etc/valet/creds/token");
      expect(second.exitCode).toBe(0);
      expect(second.stdout.trim()).toBe("bbb");
    } finally {
      await provider.destroy(sbId);
    }

    // After destroy, the host creds dir must be gone.
    await expect(access(credsDir)).rejects.toThrow();
  });

  it("resources.scratch: create mounts /scratch read-write with TMPDIR, destroy removes host dir", async () => {
    const sb = await makeSandbox({ resources: { scratch: "1Gi" } });
    const sbId = sb.id;
    const scratchDir = sb.scratchHostDir!;
    expect(scratchDir).toBeTruthy();
    // Sticky, so the workload user cannot replace a root-owned path in it
    // (fix wave 3, security H-1).
    expect((await stat(scratchDir)).mode & 0o7777).toBe(0o1777);
    try {
      const write = await sb.exec("echo hi > /scratch/test && cat /scratch/test");
      expect(write.exitCode).toBe(0);
      expect(write.stdout.trim()).toBe("hi");

      const tmpdir = await sb.exec("echo $TMPDIR");
      expect(tmpdir.exitCode).toBe(0);
      expect(tmpdir.stdout.trim()).toBe("/scratch/tmp");
    } finally {
      await provider.destroy(sbId);
    }

    // After destroy, the host scratch dir must be gone.
    await expect(access(scratchDir)).rejects.toThrow();
  });

  it("without resources.scratch — no /scratch mount and no TMPDIR override", async () => {
    const sb = await makeSandbox();
    try {
      expect(sb.scratchHostDir).toBeUndefined();
      const probe = await sb.exec("test -d /scratch");
      expect(probe.exitCode).not.toBe(0);
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("updateCreds removes files absent from the new map (stale key rotation)", async () => {
    // Create with two creds files: cred-a and cred-b.
    // Use same-length values for initial and updated cred-a so a VirtioFS
    // propagation delay (macOS Docker Desktop) can't produce a partial read
    // that looks like stale content.
    const sb = await makeSandbox({ credsFiles: { "cred-a": "aaa", "cred-b": "bbb" } });
    const sbId = sb.id;
    try {
      // Confirm both are visible in-container.
      expect((await sb.exec("cat /etc/valet/creds/cred-a")).stdout.trim()).toBe("aaa");
      expect((await sb.exec("cat /etc/valet/creds/cred-b")).stdout.trim()).toBe("bbb");

      // Rotate: only keep cred-a (updated to "zzz"), drop cred-b.
      await provider.updateCreds(sbId, { "cred-a": "zzz" });

      // cred-a is updated — same length as old value so VirtioFS serves it
      // without a propagation-delay partial-read window.
      const aResult = await sb.exec("cat /etc/valet/creds/cred-a");
      expect(aResult.exitCode).toBe(0);
      expect(aResult.stdout.trim()).toBe("zzz");

      // cred-b is gone — cat must fail (deletion propagates immediately).
      const bResult = await sb.exec("cat /etc/valet/creds/cred-b");
      expect(bResult.exitCode).not.toBe(0);
    } finally {
      await provider.destroy(sbId);
    }
  });

  it("capabilities() reports credsMount: true", () => {
    expect(provider.capabilities().credsMount).toBe(true);
  });
});

describe("docker job output helpers (fix wave 2)", () => {
  it("slices by UTF-8 bytes and never splits a codepoint (L4)", () => {
    const buf = Buffer.from("é✓\nx\n", "utf8");
    expect(sliceUtf8(buf, 0, { maxBytes: 4 })).toEqual({ text: "é", nextOffset: 2, more: true });
    expect(sliceUtf8(buf, 2, { maxBytes: 4096 })).toEqual({ text: "✓\nx\n", nextOffset: 8, more: false });
    expect(sliceUtf8(buf, 0, { maxBytes: 4, tail: true })).toEqual({ text: "\nx\n", nextOffset: 8, more: false });
    expect(sliceUtf8(buf, 2, { maxBytes: 1 })).toEqual({ text: "✓", nextOffset: 5, more: true });
  });

  it("caps a detached job at the docker maximum, and leaves a foreground cap alone (H2)", () => {
    expect(jobOutputLimit({ detached: true })).toBe(64 * 1024 * 1024);
    expect(jobOutputLimit({ detached: true, maxOutputBytes: 2 * 1024 ** 3 })).toBe(64 * 1024 * 1024);
    expect(jobOutputLimit({ detached: true, maxOutputBytes: 1000 })).toBe(1000);
    expect(jobOutputLimit({ maxOutputBytes: 5 })).toBe(5);
    expect(jobOutputLimit()).toBeUndefined();
  });
});

describe("dropFinishedDetachedOutputs (fix wave 3, security L4)", () => {
  type Job = { detached: boolean; status: "running" | "done" | "failed"; output: string };
  it("drops the oldest finished detached buffers until the total fits, and keeps running jobs", () => {
    const jobs = new Map<string, Job>([
      ["a", { detached: true, status: "done", output: "x".repeat(40) }],
      ["b", { detached: true, status: "running", output: "x".repeat(40) }],
      ["c", { detached: true, status: "failed", output: "x".repeat(40) }],
      ["d", { detached: false, status: "done", output: "x".repeat(40) }],
      ["e", { detached: true, status: "done", output: "x".repeat(40) }],
    ]);
    expect(dropFinishedDetachedOutputs(jobs, 100)).toEqual(["a", "c"]);
    expect([...jobs.keys()]).toEqual(["b", "d", "e"]);
  });

  it("drops nothing under the cap, and nothing it may not drop over it", () => {
    const jobs = new Map<string, Job>([["a", { detached: true, status: "running", output: "x".repeat(500) }]]);
    expect(dropFinishedDetachedOutputs(jobs, 100)).toEqual([]);
    expect(dropFinishedDetachedOutputs(new Map<string, Job>(), 100)).toEqual([]);
  });
});
