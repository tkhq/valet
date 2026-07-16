import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerSandboxProvider, type DockerSandboxCreateOpts } from "../src/index.js";
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
    tmp = await mkdtemp(join(tmpdir(), "valet-docker-"));
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

  it("truncates stdout to maxOutputBytes", async () => {
    const sb = await makeSandbox();
    try {
      // Print 50_000 bytes; cap at 1_000.
      const r = await sb.exec(
        "printf 'x%.0s' $(seq 1 50000)",
        { maxOutputBytes: 1_000 },
      );
      expect(r.stdout.length).toBeLessThanOrEqual(1_000);
      expect(r.truncated).toBe(true);
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
    ).rejects.toThrow(/workspace is required/);
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
      coldStartEstimateMs: 8000,
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
    // profile:"full" now runs /bin/bash /start-full.sh (see buildDockerRunArgs)
    // — alpine:3.20 has neither, so this needs the bash+script fixture image.
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
});
