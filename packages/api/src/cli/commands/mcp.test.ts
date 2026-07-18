import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { ValetConfig } from "../config.js";
import { ExitCode } from "../exit.js";
import { NoInstanceError } from "../exit.js";
import { buildMcpServerConfig, run, writeClaudeCodeConfig, type FsSeam } from "./mcp.js";

let outSpy: MockInstance;
let errSpy: MockInstance;
beforeEach(() => {
  outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());
const stdout = (): string => outSpy.mock.calls.map((c) => String(c[0])).join("");
const stderr = (): string => errSpy.mock.calls.map((c) => String(c[0])).join("");

describe("buildMcpServerConfig", () => {
  it("computes <instanceUrl>/mcp, http transport, and a placeholder bearer when no token", () => {
    const cfg = buildMcpServerConfig({ url: "https://valet.example.com", name: "valet" });
    const entry = cfg.mcpServers.valet;
    expect(entry.type).toBe("http");
    expect(entry.url).toBe("https://valet.example.com/mcp");
    expect(entry.headers.Authorization).toBe("Bearer <MCP_OAUTH_TOKEN>");
  });

  it("strips a trailing slash on the base before appending /mcp", () => {
    const cfg = buildMcpServerConfig({ url: "https://valet.example.com/", name: "valet" });
    expect(cfg.mcpServers.valet.url).toBe("https://valet.example.com/mcp");
  });

  it("strips multiple trailing slashes", () => {
    const cfg = buildMcpServerConfig({ url: "http://localhost:8787///", name: "valet" });
    expect(cfg.mcpServers.valet.url).toBe("http://localhost:8787/mcp");
  });

  it("embeds an explicit token when provided", () => {
    const cfg = buildMcpServerConfig({ url: "http://x", name: "valet", token: "tok-123" });
    expect(cfg.mcpServers.valet.headers.Authorization).toBe("Bearer tok-123");
  });

  it("honors a custom server name", () => {
    const cfg = buildMcpServerConfig({ url: "http://x", name: "myserver" });
    expect(Object.keys(cfg.mcpServers)).toEqual(["myserver"]);
  });
});

function configWith(profileUrl: string): ValetConfig {
  return { profiles: { local: { url: profileUrl, apiKey: "k" } }, defaultProfile: "local" };
}

describe("run — --print", () => {
  it("emits valid JSON with mcpServers.valet.url === <url>/mcp and type http", async () => {
    const code = await run(["setup", "claude-code", "--print"], {
      command: "mcp",
      config: configWith("http://localhost:8787"),
    });
    expect(code).toBe(ExitCode.OK);
    const parsed = JSON.parse(stdout()) as {
      mcpServers: Record<string, { type: string; url: string; headers: { Authorization: string } }>;
    };
    expect(parsed.mcpServers.valet.type).toBe("http");
    expect(parsed.mcpServers.valet.url).toBe("http://localhost:8787/mcp");
    expect(parsed.mcpServers.valet.headers.Authorization).toBe("Bearer <MCP_OAUTH_TOKEN>");
  });

  it("defaults the agent to claude-code when omitted", async () => {
    const code = await run(["setup", "--print"], { command: "mcp", config: configWith("http://x") });
    expect(code).toBe(ExitCode.OK);
    expect(JSON.parse(stdout())).toHaveProperty("mcpServers.valet");
  });

  it("writes the bearer-OAuth caveat to stderr (not stdout) so JSON stays clean", async () => {
    const code = await run(["setup", "--print"], { command: "mcp", config: configWith("http://x") });
    expect(code).toBe(ExitCode.OK);
    // stdout must remain parseable JSON
    expect(() => JSON.parse(stdout())).not.toThrow();
    expect(stderr()).toContain("OAuth bearer token");
    expect(stderr()).toContain("x-api-key");
  });

  it("embeds a --token when given and skips the caveat", async () => {
    const code = await run(["setup", "claude-code", "--print", "--token", "real-tok"], {
      command: "mcp",
      config: configWith("http://x"),
    });
    expect(code).toBe(ExitCode.OK);
    const parsed = JSON.parse(stdout()) as { mcpServers: Record<string, { headers: { Authorization: string } }> };
    expect(parsed.mcpServers.valet.headers.Authorization).toBe("Bearer real-tok");
    expect(stderr()).toBe("");
  });
});

describe("writeClaudeCodeConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "valet-mcp-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const realFs: FsSeam = {
    readFile: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    },
    writeFile: (p, c) => writeFileSync(p, c),
  };

  const entry = { type: "http" as const, url: "http://x/mcp", headers: { Authorization: "Bearer t" } };

  it("creates a fresh config file when none exists", () => {
    const path = join(dir, ".mcp.json");
    writeClaudeCodeConfig(path, "valet", entry, realFs);
    const written = JSON.parse(readFileSync(path, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(written.mcpServers.valet).toEqual(entry);
  });

  it("preserves an existing unrelated server (merge, not clobber)", () => {
    const path = join(dir, ".mcp.json");
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { other: { type: "stdio", command: "foo" } }, someTopKey: 1 }),
    );
    writeClaudeCodeConfig(path, "valet", entry, realFs);
    const written = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers: Record<string, unknown>;
      someTopKey: number;
    };
    expect(written.mcpServers.other).toEqual({ type: "stdio", command: "foo" });
    expect(written.mcpServers.valet).toEqual(entry);
    expect(written.someTopKey).toBe(1);
  });

  it("overwrites a prior entry under the same name", () => {
    const path = join(dir, ".mcp.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { valet: { type: "http", url: "http://old/mcp", headers: {} } } }));
    writeClaudeCodeConfig(path, "valet", entry, realFs);
    const written = JSON.parse(readFileSync(path, "utf8")) as { mcpServers: Record<string, typeof entry> };
    expect(written.mcpServers.valet).toEqual(entry);
  });

  it("throws a clear error on malformed existing JSON rather than clobbering it", () => {
    const path = join(dir, ".mcp.json");
    writeFileSync(path, "{ not valid json ");
    expect(() => writeClaudeCodeConfig(path, "valet", entry, realFs)).toThrow(/valid JSON/);
    // the original file must be untouched
    expect(readFileSync(path, "utf8")).toBe("{ not valid json ");
  });
});

describe("run — usage / errors", () => {
  it("unknown subcommand → Usage", async () => {
    const code = await run(["bogus"], { command: "mcp", config: configWith("http://x") });
    expect(code).toBe(ExitCode.Usage);
    expect(stderr()).toContain("usage");
  });

  it("missing subcommand → Usage", async () => {
    const code = await run([], { command: "mcp", config: configWith("http://x") });
    expect(code).toBe(ExitCode.Usage);
  });

  it("unknown agent → Usage", async () => {
    const code = await run(["setup", "vscode"], { command: "mcp", config: configWith("http://x") });
    expect(code).toBe(ExitCode.Usage);
    expect(stderr()).toContain("agent");
  });

  it("no instance configured → NoInstanceError propagates (exit 2)", async () => {
    const prev = process.env.VALET_INSTANCE;
    delete process.env.VALET_INSTANCE;
    try {
      await expect(run(["setup", "--print"], { command: "mcp", config: {} })).rejects.toBeInstanceOf(NoInstanceError);
    } finally {
      if (prev !== undefined) process.env.VALET_INSTANCE = prev;
    }
  });
});
