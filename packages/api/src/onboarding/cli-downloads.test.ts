import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../env.js";
import { mountOnboardingRoutes } from "./routes.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function app() {
  const result = new Hono<AppEnv>();
  mountOnboardingRoutes(result);
  return result;
}

describe("instance CLI installer", () => {
  it("uses this instance's configured public URL and names the exact setup commands", async () => {
    vi.stubEnv("VALET_PUBLIC_URL", "https://valet.example.com/");
    const res = await app().request("http://internal/cli/install.sh");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/x-shellscript");
    const script = await res.text();
    expect(script).toContain("https://valet.example.com/cli/downloads/");
    expect(script).toContain("proxy list");
    expect(script).toContain("valet proxy setup");
    expect(script).not.toContain("http://internal");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects a non-HTTP public URL instead of embedding shell input", async () => {
    vi.stubEnv("VALET_PUBLIC_URL", "https://valet.example.com/'; echo unsafe");
    const res = await app().request("http://internal/cli/install.sh");
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("echo unsafe");
  });

  it("redirects supported release downloads when no local directory is configured", async () => {
    vi.stubEnv("VALET_CLI_DOWNLOAD_DIR", "");
    const res = await app().request("http://internal/cli/downloads/valet-darwin-arm64");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://github.com/tkhq/valet/releases/download/dev-v2-latest/valet-darwin-arm64");
  });

  it("streams an allowlisted local binary and never serves arbitrary file names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "valet-cli-download-"));
    dirs.push(dir);
    vi.stubEnv("VALET_CLI_DOWNLOAD_DIR", dir);
    await writeFile(join(dir, "valet-linux-x64"), "test-binary");
    await writeFile(join(dir, "config.json"), "private-config");
    const res = await app().request("http://internal/cli/downloads/valet-linux-x64");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toContain("valet-linux-x64");
    expect(await res.text()).toBe("test-binary");
    expect((await app().request("http://internal/cli/downloads/config.json")).status).toBe(404);
    expect((await app().request("http://internal/cli/downloads/valet-windows-x64")).status).toBe(404);
  });

  it("reports an unpublished local target instead of redirecting to a different CLI version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "valet-cli-download-"));
    dirs.push(dir);
    vi.stubEnv("VALET_CLI_DOWNLOAD_DIR", dir);
    const res = await app().request("http://internal/cli/downloads/valet-linux-arm64");
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Ask your Valet admin");
  });
});
