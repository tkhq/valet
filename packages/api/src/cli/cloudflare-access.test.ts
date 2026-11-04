import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { InstanceClient } from "./client.js";
import { accessBlockedMessage, accessToken, isAccessBlock, resetAccessTokens } from "./cloudflare-access.js";
import { startDeviceLogin } from "./device-login.js";
import { AuthError } from "./exit.js";
import { streamSession } from "./stream.js";

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

const { execFileMock, spawnMock } = vi.hoisted(() => ({ execFileMock: vi.fn(), spawnMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: execFileMock,
  spawn: spawnMock,
}));

const BASE = "https://valet.example.com";
const LOGIN_URL = "https://tkhq.cloudflareaccess.com/cdn-cgi/access/login/valet.example.com?redirect_url=%2F";

/** What `fetch` returns after following the Access redirect to the login page. */
function loginPage(): Response {
  const res = new Response("<html>Sign in</html>", { status: 200, headers: { "content-type": "text/html" } });
  Object.defineProperty(res, "redirected", { value: true });
  Object.defineProperty(res, "url", { value: LOGIN_URL });
  return res;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** `cloudflared access token` prints this token, or fails like a missing token. */
function cloudflaredTokens(...outputs: Array<string | undefined>): void {
  for (const out of outputs) {
    execFileMock.mockImplementationOnce((_file: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
      if (out === undefined) cb(new Error("Unable to find token for provided application."), "", "");
      else cb(null, `${out}\n`, "");
    });
  }
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (!headers || headers instanceof Headers || Array.isArray(headers)) return undefined;
  return headers[name];
}

/** A fetch stub that serves `ok` only with the expected Access token. */
function accessGate(token: string, ok: () => Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    headerOf(init, "cf-access-token") === token ? ok() : loginPage(),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function setTty(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
  Object.defineProperty(process.stderr, "isTTY", { value, configurable: true });
}

const stdinTty = process.stdin.isTTY;
const stderrTty = process.stderr.isTTY;

beforeEach(() => {
  resetAccessTokens();
  execFileMock.mockReset();
  spawnMock.mockReset();
  vi.stubEnv("VALET_CF_ACCESS_TOKEN", "");
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  setTty(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  Object.defineProperty(process.stdin, "isTTY", { value: stdinTty, configurable: true });
  Object.defineProperty(process.stderr, "isTTY", { value: stderrTty, configurable: true });
});

describe("isAccessBlock", () => {
  it("detects a followed redirect to the Access login page", () => {
    expect(isAccessBlock(loginPage())).toBe(true);
  });

  it("detects a 3xx whose location is the Access login page", () => {
    expect(isAccessBlock(new Response(null, { status: 302, headers: { location: LOGIN_URL } }))).toBe(true);
  });

  it("ignores a normal 200 and a redirect to another host", () => {
    expect(isAccessBlock(json({ ok: true }))).toBe(false);
    expect(isAccessBlock(new Response(null, { status: 302, headers: { location: "https://valet.example.com/login" } }))).toBe(false);
  });
});

describe("accessToken", () => {
  it("uses VALET_CF_ACCESS_TOKEN without running cloudflared", async () => {
    vi.stubEnv("VALET_CF_ACCESS_TOKEN", "env-token");
    expect(await accessToken(BASE)).toBe("env-token");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("reads the token from cloudflared for the origin, once per process", async () => {
    cloudflaredTokens("cf-token");
    expect(await accessToken(`${BASE}/api/me`)).toBe("cf-token");
    expect(await accessToken(BASE)).toBe("cf-token");
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]?.[1]).toEqual(["access", "token", `-app=${BASE}`]);
  });

  it("never starts a browser sign-in when not interactive", async () => {
    cloudflaredTokens(undefined);
    expect(await accessToken(BASE)).toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("starts cloudflared access login in a terminal, then reads the token", async () => {
    setTty(true);
    cloudflaredTokens(undefined, "after-login");
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter();
      setImmediate(() => child.emit("exit", 0));
      return child;
    });
    expect(await accessToken(BASE)).toBe("after-login");
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(["access", "login", BASE]);
  });
});

describe("InstanceClient behind Cloudflare Access", () => {
  it("sends the request once more with cf-access-token, and keeps the token", async () => {
    cloudflaredTokens("cf-token");
    const fetchMock = accessGate("cf-token", () => json({ ok: true, service: "valet-api", ts: 1 }));
    const client = new InstanceClient({ url: BASE, apiKey: "vlt_key" });

    expect((await client.health()).ok).toBe(true);
    await client.health();
    await new InstanceClient({ url: BASE }).health();

    // One block, then every request carries the token. One cloudflared call.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(headerOf(fetchMock.mock.calls[0]?.[1], "cf-access-token")).toBeUndefined();
    expect(headerOf(fetchMock.mock.calls[1]?.[1], "cf-access-token")).toBe("cf-token");
    expect(headerOf(fetchMock.mock.calls[1]?.[1], "x-api-key")).toBe("vlt_key");
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("throws AuthError with the cloudflared steps when no token passes", async () => {
    cloudflaredTokens(undefined);
    accessGate("never", () => json({}));
    const err = await new InstanceClient({ url: BASE }).health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).message).toBe(accessBlockedMessage(BASE));
    expect((err as AuthError).message).toContain(`cloudflared access login ${BASE}`);
  });

  it("does not run cloudflared or send the header when nothing blocks", async () => {
    const fetchMock = vi.fn(async () => json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await new InstanceClient({ url: BASE }).health();
    expect(execFileMock).not.toHaveBeenCalled();
    expect(headerOf(fetchMock.mock.calls[0]?.[1], "cf-access-token")).toBeUndefined();
  });
});

describe("valet login behind Cloudflare Access", () => {
  it("starts a device sign-in with cf-access-token after a block", async () => {
    cloudflaredTokens("cf-token");
    const fetchMock = accessGate("cf-token", () =>
      json({ device_code: "d1", user_code: "ABCD-EFGH", verification_path: "/cli/device", expires_in: 600, interval: 5 }),
    );
    const pending = await startDeviceLogin(BASE, "laptop", () => 0);
    expect(pending.userCode).toBe("ABCD-EFGH");
    expect(headerOf(fetchMock.mock.calls[1]?.[1], "cf-access-token")).toBe("cf-token");
  });
});

describe("streamSession behind Cloudflare Access", () => {
  let server: Server;
  let wss: WebSocketServer;
  let baseUrl: string;
  let upgradeTokens: Array<string | undefined>;
  let abort: AbortController;

  beforeEach(async () => {
    upgradeTokens = [];
    abort = new AbortController();
    // Plain HTTP (the stream's Access check) answers like a reachable instance.
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      const token = req.headers["cf-access-token"];
      upgradeTokens.push(typeof token === "string" ? token : undefined);
      if (token !== "cf-token") {
        socket.end(`HTTP/1.1 302 Found\r\nLocation: ${LOGIN_URL}\r\nContent-Length: 0\r\n\r\n`);
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(JSON.stringify({ type: "ping", seq: 1, ts: 1 }));
        ws.close(1000);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    // A failed test must not leave the stream reconnecting.
    abort.abort();
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function collect(): Promise<string[]> {
    const types: string[] = [];
    for await (const ev of streamSession({ url: baseUrl, sessionId: "s1", signal: abort.signal })) types.push(ev.type);
    return types;
  }

  it("sends a cached token on the upgrade", async () => {
    vi.stubEnv("VALET_CF_ACCESS_TOKEN", "cf-token");
    await accessToken(baseUrl);
    expect(await collect()).toEqual(["ping"]);
    expect(upgradeTokens).toEqual(["cf-token"]);
  });

  it("gets a token after a blocked upgrade when the stream is the first request", async () => {
    cloudflaredTokens("cf-token");
    accessGate("cf-token", () => json({ ok: true }));
    expect(await collect()).toEqual(["ping"]);
    expect(upgradeTokens).toEqual([undefined, "cf-token"]);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("fails with the cloudflared steps when no token passes", async () => {
    cloudflaredTokens(undefined);
    accessGate("never", () => json({}));
    await expect(collect()).rejects.toThrow(accessBlockedMessage(baseUrl));
  });
});
