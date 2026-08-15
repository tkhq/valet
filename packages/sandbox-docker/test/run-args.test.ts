import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { buildDockerRunArgs, credsCheckScript, writeCredsFiles } from "../src/sandbox.js";

const baseOpts = {
  containerName: "valet-sandbox-test",
  image: "alpine:3.20",
  workspaceHostPath: "/tmp/valet-ws",
  network: "bridge",
};

describe("buildDockerRunArgs (pure)", () => {
  it("headless (profile omitted) publishes no ports — byte-identical pin", () => {
    const args = buildDockerRunArgs(baseOpts);
    expect(args).not.toContain("-p");
    expect(args).toEqual([
      "run",
      "-d",
      "--name",
      "valet-sandbox-test",
      "--workdir",
      "/workspace",
      "-v",
      "/tmp/valet-ws:/workspace",
      "alpine:3.20",
      "sh",
      "-c",
      "tail -f /dev/null",
    ]);
  });

  it("headless (profile: 'headless' explicit) publishes no ports — byte-identical pin", () => {
    const args = buildDockerRunArgs({ ...baseOpts, profile: "headless" });
    expect(args).not.toContain("-p");
  });

  it("full profile publishes 9000 to an ephemeral loopback port", () => {
    const args = buildDockerRunArgs({ ...baseOpts, profile: "full" });
    const idx = args.indexOf("-p");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("127.0.0.1::9000");
  });

  it("full profile still includes the rest of the standard args, and degrades to tail when /start-full.sh is missing — byte-identical pin", () => {
    const args = buildDockerRunArgs({ ...baseOpts, profile: "full" });
    expect(args).toEqual([
      "run",
      "-d",
      "--name",
      "valet-sandbox-test",
      "--workdir",
      "/workspace",
      "-v",
      "/tmp/valet-ws:/workspace",
      "-p",
      "127.0.0.1::9000",
      "alpine:3.20",
      "sh",
      "-c",
      "[ -f /start-full.sh ] && exec /bin/bash /start-full.sh || exec tail -f /dev/null",
    ]);
  });

  it("headless (profile omitted) keeps the tail placeholder trailing command — byte-identical pin", () => {
    const args = buildDockerRunArgs(baseOpts);
    expect(args.slice(-4)).toEqual(["alpine:3.20", "sh", "-c", "tail -f /dev/null"]);
  });

  it("emits --network only when non-bridge", () => {
    const bridge = buildDockerRunArgs(baseOpts);
    expect(bridge).not.toContain("--network");
    const none = buildDockerRunArgs({ ...baseOpts, network: "none" });
    const idx = none.indexOf("--network");
    expect(idx).toBeGreaterThan(-1);
    expect(none[idx + 1]).toBe("none");
  });

  it("emits --env per entry", () => {
    const args = buildDockerRunArgs({ ...baseOpts, env: { FOO: "bar", BAZ: "qux" } });
    expect(args).toEqual(
      expect.arrayContaining(["--env", "FOO=bar", "--env", "BAZ=qux"]),
    );
  });

  it("emits --cpus/--memory when resources are set", () => {
    const args = buildDockerRunArgs({ ...baseOpts, resources: { cpu: 2, memory: "4Gi" } });
    expect(args).toEqual(expect.arrayContaining(["--cpus", "2", "--memory", "4Gi"]));
  });

  it("is a pure function — identical inputs produce deep-equal output", () => {
    const first = buildDockerRunArgs({ ...baseOpts, profile: "full", env: { A: "1" } });
    const second = buildDockerRunArgs({ ...baseOpts, profile: "full", env: { A: "1" } });
    expect(first).toEqual(second);
  });

  it("without credsHostDir — output is byte-identical to the baseline (regression pin)", () => {
    const withoutCreds = buildDockerRunArgs(baseOpts);
    const baseline = [
      "run",
      "-d",
      "--name",
      "valet-sandbox-test",
      "--workdir",
      "/workspace",
      "-v",
      "/tmp/valet-ws:/workspace",
      "alpine:3.20",
      "sh",
      "-c",
      "tail -f /dev/null",
    ];
    expect(withoutCreds).toEqual(baseline);
  });

  it("with credsHostDir — adds exactly one -v flag for /etc/valet/creds:ro after the workspace volume", () => {
    const args = buildDockerRunArgs({ ...baseOpts, credsHostDir: "/home/user/.valet/creds/dsb-1" });
    const wsIdx = args.indexOf("-v");
    // The workspace volume is first.
    expect(args[wsIdx + 1]).toBe("/tmp/valet-ws:/workspace");
    // The creds volume is the very next -v flag.
    const credsIdx = args.indexOf("-v", wsIdx + 1);
    expect(credsIdx).toBeGreaterThan(wsIdx);
    expect(args[credsIdx + 1]).toBe("/home/user/.valet/creds/dsb-1:/etc/valet/creds:ro");
    // Exactly two -v flags total.
    const allVFlags = args.reduce((n, a) => n + (a === "-v" ? 1 : 0), 0);
    expect(allVFlags).toBe(2);
  });
});

describe("writeCredsFiles (pure — no Docker required)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "valet-creds-unit-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('rejects traversal key "../evil" before writing any file', async () => {
    await expect(writeCredsFiles(tmp, { "../evil": "x" })).rejects.toThrow(
      /unsafe key.*\.\.\/evil/,
    );
    // Nothing must have been written — the evil path should not exist.
    await expect(access(join(tmp, "..", "evil"))).rejects.toThrow();
  });

  it("rejects keys containing path separators", async () => {
    await expect(writeCredsFiles(tmp, { "a/b": "x" })).rejects.toThrow(/unsafe key.*a\/b/);
  });

  it("rejects '.' and '..' as keys", async () => {
    await expect(writeCredsFiles(tmp, { ".": "x" })).rejects.toThrow(/unsafe key/);
    await expect(writeCredsFiles(tmp, { "..": "x" })).rejects.toThrow(/unsafe key/);
  });

  it("accepts plain filenames and writes them with mode 0600", async () => {
    await expect(writeCredsFiles(tmp, { token: "abc", other: "def" })).resolves.toBeUndefined();
    // Both files exist; no error thrown on access.
    await expect(access(join(tmp, "token"))).resolves.toBeUndefined();
    await expect(access(join(tmp, "other"))).resolves.toBeUndefined();
  });
});

describe("credsCheckScript (pure — no Docker required)", () => {
  it("checks each file's content base64-encoded and each removed name's absence", () => {
    const script = credsCheckScript({ token: "abc" }, ["stale"]);
    const b64 = Buffer.from("abc", "utf8").toString("base64");
    expect(script).toContain(`base64 < '/etc/valet/creds/token'`);
    expect(script).toContain(`= '${b64}' ] || exit 1`);
    expect(script).toContain(`[ ! -e '/etc/valet/creds/stale' ] || exit 1`);
    expect(script.endsWith("exit 0")).toBe(true);
  });

  it("never embeds the secret content in shell syntax", () => {
    const secret = "s3cr3t'; rm -rf / #";
    const script = credsCheckScript({ token: secret }, []);
    expect(script).not.toContain(secret);
    expect(script).toContain(Buffer.from(secret, "utf8").toString("base64"));
  });

  it("quotes removed filenames for a single-quoted shell context", () => {
    const script = credsCheckScript({}, ["odd'name"]);
    expect(script).toContain(`'/etc/valet/creds/odd'\\''name'`);
  });

  it("reduces to a bare success for empty inputs", () => {
    expect(credsCheckScript({}, [])).toBe("exit 0");
  });
});

describe("credsCheckScript path-traversal guard", () => {
  it("rejects traversal in file keys", () => {
    expect(() => credsCheckScript({ "../../../etc/passwd": "x" }, [])).toThrow(
      /unsafe key.*etc\/passwd/,
    );
    expect(() => credsCheckScript({ "a/b": "x" }, [])).toThrow(/unsafe key/);
  });

  it("rejects traversal in removed names", () => {
    expect(() => credsCheckScript({}, ["../outside"])).toThrow(/unsafe key/);
    expect(() => credsCheckScript({}, ["."])).toThrow(/unsafe key/);
  });
});

describe("docker flag (rootless DinD)", () => {
  const base = {
    containerName: "valet-sandbox-x",
    image: "img:1",
    workspaceHostPath: "/tmp/ws",
    network: "bridge",
  };

  it("adds exactly the rootless relaxations when docker is true", () => {
    const args = buildDockerRunArgs({ ...base, docker: true });
    const joined = args.join(" ");
    expect(joined).toContain("--security-opt seccomp=unconfined");
    expect(joined).toContain("--security-opt apparmor=unconfined");
    expect(joined).toContain("--device /dev/fuse");
    expect(joined).toContain("--env VALET_SANDBOX_DOCKER=1");
    expect(joined).not.toContain("--privileged");
  });

  it("headless+docker runs the start-headless probe wrapper", () => {
    const args = buildDockerRunArgs({ ...base, docker: true });
    expect(args[args.length - 1]).toBe(
      "[ -f /start-headless.sh ] && exec /bin/bash /start-headless.sh || exec tail -f /dev/null",
    );
  });

  it("emits nothing docker-related when the flag is absent", () => {
    const joined = buildDockerRunArgs(base).join(" ");
    expect(joined).not.toContain("seccomp");
    expect(joined).not.toContain("apparmor");
    expect(joined).not.toContain("/dev/fuse");
    expect(joined).not.toContain("VALET_SANDBOX_DOCKER");
  });
});
