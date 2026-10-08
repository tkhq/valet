import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.each([
  ["native", "overlay2"],
  ["fuse", "fuse-overlayfs"],
  ["mount-fails", "vfs"],
  ["exec-fails", "vfs"],
])("selects a usable Docker storage driver when %s", (scenario, driver) => {
  const dir = mkdtempSync(join(tmpdir(), "valet-storage-test-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const commands: Record<string, string> = {
      // Keep the production probe commands; replace privilege and mount boundaries.
      su: 'exec /bin/sh -c "$5"',
      unshare: 'shift 3; exec "$@"',
      mount: '[ "$SCENARIO" = native ]',
      cp: 'exec /bin/cp /usr/bin/true "$2"',
      umount: 'echo unmounted >> "$LOG"',
      "fuse-overlayfs": `
        [ "$SCENARIO" != mount-fails ] || exit 1
        result=0; [ "$SCENARIO" != exec-fails ] || result=126
        printf '#!/bin/sh\\necho executed >> "$LOG"\\nexit %s\\n' "$result" > .ovlprobe/m/probe
        chmod +x .ovlprobe/m/probe`,
    };
    for (const [name, body] of Object.entries(commands)) {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    }
    const source = readFileSync(new URL("../../docker/start-docker.sh", import.meta.url), "utf8");
    const start = source.indexOf("DRIVER=vfs", source.indexOf("# ── Rootless dockerd"));
    const end = source.indexOf('su -s /bin/bash dockerd -c', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const data = join(dir, "data");
    mkdirSync(data);
    const log = join(dir, "probe.log");
    execFileSync("bash", ["-eu", "-c", source.slice(start, end)], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DATA_ROOT: data, LOG: log, SCENARIO: scenario },
    });
    const output = readFileSync(log, "utf8");
    expect(output).toContain(`storage driver: ${driver}`);
    if (scenario === "fuse" || scenario === "exec-fails") {
      expect(output).toContain("executed");
      expect(output).toContain("unmounted");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
