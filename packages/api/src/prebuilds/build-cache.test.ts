import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCachePruneArgs, pruneBuildCache } from "./build-cache.js";
import type { SpawnedProcess, SpawnFn } from "./docker-builder.js";

// ---------------------------------------------------------------------------
// Minimal fake SpawnedProcess (mirrors docker-builder.test.ts's FakeChild)
// ---------------------------------------------------------------------------

class FakeChild extends EventEmitter implements SpawnedProcess {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    process.nextTick(() => this.emit("close", null, "SIGKILL"));
    return true;
  }
}

interface RecordedCall {
  command: string;
  args: string[];
}

function fakeSpawnFn(onSpawn: (child: FakeChild, call: RecordedCall) => void): {
  spawnFn: SpawnFn;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const spawnFn: SpawnFn = (command, args) => {
    const call = { command, args };
    calls.push(call);
    const child = new FakeChild();
    child.stdin.on("data", () => {});
    setImmediate(() => onSpawn(child, call));
    return child;
  };
  return { spawnFn, calls };
}

// ---------------------------------------------------------------------------
// buildCachePruneArgs
// ---------------------------------------------------------------------------

describe("buildCachePruneArgs", () => {
  it("returns the expected docker builder prune argv for a 10 GB cap", () => {
    expect(buildCachePruneArgs(10)).toEqual([
      "builder",
      "prune",
      "-f",
      "--keep-storage",
      "10GB",
    ]);
  });

  it("uses the supplied cap value verbatim", () => {
    expect(buildCachePruneArgs(25)).toEqual([
      "builder",
      "prune",
      "-f",
      "--keep-storage",
      "25GB",
    ]);
  });
});

// ---------------------------------------------------------------------------
// pruneBuildCache — happy path
// ---------------------------------------------------------------------------

describe("pruneBuildCache — happy path", () => {
  it("spawns docker with the prune args and resolves on exit 0", async () => {
    const { spawnFn, calls } = fakeSpawnFn((child) => {
      child.emit("close", 0, null);
    });

    await expect(pruneBuildCache(spawnFn, 10)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("docker");
    expect(calls[0]!.args).toEqual(buildCachePruneArgs(10));
  });
});

// ---------------------------------------------------------------------------
// pruneBuildCache — best-effort: never rejects
// ---------------------------------------------------------------------------

describe("pruneBuildCache — best-effort (never rejects)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves (does NOT reject) when the child exits non-zero, and logs via console.error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { spawnFn } = fakeSpawnFn((child) => {
      child.emit("close", 1, null);
    });

    await expect(pruneBuildCache(spawnFn, 10)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it("resolves (does NOT reject) when the spawn function throws synchronously, and logs via console.error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const throwingSpawn: SpawnFn = () => {
      throw new Error("ENOENT: docker not found");
    };

    await expect(pruneBuildCache(throwingSpawn, 10)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it("logs exactly once when the child emits error then close (ENOENT / spawn-fail pattern)", async () => {
    // Node emits `error` followed by `close` (code null) for ENOENT.  Without
    // the `errored` guard both events would log — this test pins the fix.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { spawnFn } = fakeSpawnFn((child) => {
      child.emit("error", new Error("spawn ENOENT"));
      // Node emits close with code null after an error event.
      child.emit("close", null, null);
    });

    await expect(pruneBuildCache(spawnFn, 10)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledOnce();
  });
});
