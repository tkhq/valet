import { describe, it, expect } from "vitest";
import { measureBakeSize } from "./bake-size.js";
import type { SpawnFn, SpawnedProcess } from "./docker-builder.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/** Builds a minimal fake SpawnedProcess for SpawnFn fakes. */
function fakeProcess(opts: {
  stdout?: string;
  exitCode?: number;
  errorEvent?: Error;
}): SpawnedProcess {
  const bus = new EventEmitter();
  const stdoutStream = new PassThrough();
  // Emit events asynchronously so listeners can attach first.
  setImmediate(() => {
    if (opts.errorEvent) {
      bus.emit("error", opts.errorEvent);
    } else {
      if (opts.stdout !== undefined) {
        stdoutStream.push(Buffer.from(opts.stdout));
      }
      bus.emit("close", opts.exitCode ?? 0, null);
    }
  });

  // SpawnedProcess.on is overloaded; the implementation signature must be
  // a supertype of both overloads so TypeScript accepts it.
  function onEvent(
    event: "error" | "close",
    listener: ((err: Error) => void) & ((code: number | null, signal: NodeJS.Signals | null) => void),
  ): SpawnedProcess {
    bus.on(event, listener as (...args: unknown[]) => void);
    return proc;
  }

  const proc: SpawnedProcess = {
    stdout: stdoutStream,
    stderr: null,
    stdin: null,
    kill: () => true,
    on: onEvent,
  };
  return proc;
}

function noopSpawn(): SpawnedProcess {
  return fakeProcess({ stdout: "0", exitCode: 0 });
}

const noopFetch: typeof fetch = async () => new Response(null, { status: 500 });

describe("measureBakeSize", () => {
  describe("docker backend", () => {
    it("returns bytes when docker inspect succeeds", async () => {
      const spawnFn: SpawnFn = (_cmd, _args, _opts) => fakeProcess({ stdout: "12345\n", exitCode: 0 });
      const result = await measureBakeSize("docker", "valet-prebuild/foo:sha", {
        spawnFn,
        fetchImpl: noopFetch,
        registryInsecure: false,
      });
      expect(result).toBe(12345);
    });

    it("returns null when docker spawn exits non-zero", async () => {
      const spawnFn: SpawnFn = () => fakeProcess({ stdout: "", exitCode: 1 });
      const result = await measureBakeSize("docker", "valet-prebuild/foo:sha", {
        spawnFn,
        fetchImpl: noopFetch,
        registryInsecure: false,
      });
      expect(result).toBeNull();
    });

    it("returns null when docker spawn throws", async () => {
      const spawnFn: SpawnFn = () => {
        throw new Error("spawn ENOENT");
      };
      const result = await measureBakeSize("docker", "valet-prebuild/foo:sha", {
        spawnFn,
        fetchImpl: noopFetch,
        registryInsecure: false,
      });
      expect(result).toBeNull();
    });

    it("returns null when docker inspect emits error event", async () => {
      const spawnFn: SpawnFn = () => fakeProcess({ errorEvent: new Error("ECONNREFUSED") });
      const result = await measureBakeSize("docker", "valet-prebuild/foo:sha", {
        spawnFn,
        fetchImpl: noopFetch,
        registryInsecure: false,
      });
      expect(result).toBeNull();
    });
  });

  describe("kubernetes backend", () => {
    it("returns sum of config+layer sizes from registry manifest", async () => {
      const manifest = { config: { size: 100 }, layers: [{ size: 200 }, { size: 300 }] };
      const fetchImpl: typeof fetch = async () =>
        new Response(JSON.stringify(manifest), { status: 200 });
      const result = await measureBakeSize(
        "kubernetes",
        "registry.example.com/valet-prebuild/foo:sha",
        {
          spawnFn: noopSpawn,
          fetchImpl,
          registryInsecure: true,
        },
      );
      expect(result).toBe(600);
    });

    it("returns null on non-2xx registry response", async () => {
      const fetchImpl: typeof fetch = async () => new Response(null, { status: 404 });
      const result = await measureBakeSize(
        "kubernetes",
        "registry.example.com/valet-prebuild/foo:sha",
        {
          spawnFn: noopSpawn,
          fetchImpl,
          registryInsecure: true,
        },
      );
      expect(result).toBeNull();
    });

    it("returns null when fetch throws", async () => {
      const fetchImpl: typeof fetch = async () => {
        throw new Error("ECONNREFUSED");
      };
      const result = await measureBakeSize(
        "kubernetes",
        "registry.example.com/valet-prebuild/foo:sha",
        {
          spawnFn: noopSpawn,
          fetchImpl,
          registryInsecure: true,
        },
      );
      expect(result).toBeNull();
    });

    it("returns null when manifest body is not the expected shape", async () => {
      const fetchImpl: typeof fetch = async () =>
        new Response(JSON.stringify({ unexpected: true }), { status: 200 });
      const result = await measureBakeSize(
        "kubernetes",
        "registry.example.com/valet-prebuild/foo:sha",
        {
          spawnFn: noopSpawn,
          fetchImpl,
          registryInsecure: true,
        },
      );
      expect(result).toBeNull();
    });
  });

  describe("unknown backend", () => {
    it("returns null", async () => {
      const result = await measureBakeSize("localvm", "some-image:tag", {
        spawnFn: noopSpawn,
        fetchImpl: noopFetch,
        registryInsecure: false,
      });
      expect(result).toBeNull();
    });
  });
});
