// @vitest-environment node
/**
 * `valet-secrets http` runs `HTTP_JS` under node. These tests run the real
 * program against a stand-in broker and check what it sends and prints.
 */
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HTTP_JS } from "./secrets-http.js";

let close: (() => void) | undefined;
afterEach(() => {
  close?.();
  close = undefined;
});

async function broker(reply: { status: number; body: unknown }) {
  const seen: { headers: IncomingMessage["headers"]; body: unknown }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      seen.push({ headers: req.headers, body: JSON.parse(raw) as unknown });
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  close = () => server.close();
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function run(api: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", HTTP_JS, "--", ...args], {
      env: { ...process.env, VALET_HTTP_API: api, VALET_HTTP_TOKEN: "tok-1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe("valet-secrets http", () => {
  it("removes the placeholder header, sends the reference, and prints the body and status", async () => {
    const b = await broker({
      status: 200,
      body: { status: 200, headers: [["content-type", "application/json"]], body: Buffer.from('{"ok":true}').toString("base64"), receipt: {} },
    });
    const out = await run(b.url, [
      "post",
      "https://api.example.com/v1/x",
      "-H",
      "Authorization: Bearer {{secret://personal/EXAMPLE_KEY}}",
      "-H",
      "Content-Type: application/json",
      "-d",
      '{"a":1}',
    ]);
    expect(out.code).toBe(0);
    expect(out.stdout).toBe('{"ok":true}');
    expect(out.stderr).toBe("HTTP 200\n");
    expect(b.seen[0]!.headers["x-valet-sandbox"]).toBe("tok-1");
    expect(b.seen[0]!.body).toEqual({
      reference: "secret://personal/EXAMPLE_KEY",
      header: "authorization",
      request: {
        method: "POST",
        url: "https://api.example.com/v1/x",
        headers: { "content-type": "application/json" },
        body: Buffer.from('{"a":1}').toString("base64"),
      },
    });
  });

  it("refuses a request with no placeholder or two, before calling the broker", async () => {
    const b = await broker({ status: 200, body: {} });
    const none = await run(b.url, ["GET", "https://api.example.com/", "-H", "Accept: x"]);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain("exactly one header");
    const two = await run(b.url, ["GET", "https://api.example.com/", "-H", "A: {{secret://personal/X}}", "-H", "B: {{secret://personal/Y}}"]);
    expect(two.code).toBe(2);
    expect(b.seen).toHaveLength(0);
  });

  it("prints the broker's refusal and exits 4", async () => {
    const b = await broker({ status: 403, body: { error: "This secret can only be used with api.example.com." } });
    const out = await run(b.url, ["GET", "https://other.example/", "-H", "Authorization: Bearer {{secret://personal/X}}"]);
    expect(out.code).toBe(4);
    expect(out.stderr).toBe("valet-secrets: This secret can only be used with api.example.com.\n");
  });

  it("names a redirect it did not follow", async () => {
    const b = await broker({ status: 200, body: { status: 302, headers: [["location", "https://elsewhere.example/"]], body: "", receipt: {} } });
    const out = await run(b.url, ["GET", "https://api.example.com/", "-H", "Authorization: Bearer {{secret://personal/X}}"]);
    expect(out.stderr).toContain("HTTP 302");
    expect(out.stderr).toContain("location: https://elsewhere.example/ (not followed");
  });
});
