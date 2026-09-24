import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PluginActionContext, Sandbox } from "@valet/engine";
import type {
  BrowserPolicyRequest,
  BrowserRequest,
  BrowserResponse,
} from "@valet/shared";
import { browserPlugin } from "./actions.js";

const identity = {
  protocolVersion: "1.0" as const,
  sessionId: "s",
  threadId: "t",
  actorId: "u",
  ownerId: "u",
};
const approval: BrowserPolicyRequest = {
  ...identity,
  cellId: "cell",
  invocationId: "call",
  runtimeId: "run",
  operationId: "op",
  hash: "hash",
  method: "locator.click",
  operationClass: "mutation",
  origin: "https://example.com",
  target: "Submit",
  policyVersion: "1",
  expiresAt: Date.now() + 60_000,
};
const image = new TextEncoder().encode("pixels");
const artifact = {
  id: "shot",
  sessionId: "s",
  runtimeId: "run",
  mimeType: "image/png",
  bytes: image.length,
  sha256: createHash("sha256").update(image).digest("hex"),
  filename: "shot.png",
  createdAt: 1,
};

function fixture(
  options: { denied?: boolean; image?: boolean; authorized?: boolean } = {},
) {
  const requests: BrowserRequest[] = [];
  const decisions: string[] = [];
  const sandbox: Sandbox = {
    id: "sb",
    readFile: async () => "",
    readBinary: async () => image,
    writeFile: async () => {},
    writeBinary: async () => {},
    readdir: async () => [],
    stat: async () => ({
      isFile: true,
      isDirectory: false,
      size: image.length,
    }),
    mkdir: async () => {},
    rm: async () => {},
    exec: async (command, opts) => {
      if (command.startsWith("/usr/bin/env -i ")) {
        expect(opts?.privileged).toBe(true);
        return {
          exitCode: 0,
          stdout: Buffer.from(image).toString("base64"),
          stderr: "",
        };
      }
      expect(command).toBe("/usr/local/bin/valet-browser-client");
      const request: BrowserRequest = JSON.parse(opts?.stdin ?? "null");
      requests.push(request);
      const response: BrowserResponse = {
        protocolVersion: "1.0",
        runtimeId: "run",
        ok: true,
        cursor: requests.length,
        gap: false,
        events: [],
      };
      if (request.command === "submit")
        response.events = [
          { type: "approval", request: approval, timestamp: 1, cursor: 1 },
        ];
      if (request.command === "resolve") {
        response.cell = {
          cellId: "cell",
          invocationId: "call",
          runtimeId: "run",
          threadId: "t",
          status: "completed",
          operations: [],
        };
        response.events = [
          { type: "text", text: "done", timestamp: 2, cursor: 2 },
        ];
        if (options.image)
          response.events.push({
            type: "artifact",
            artifact,
            timestamp: 3,
            cursor: 3,
          });
      }
      if (request.command === "events")
        response.cell = {
          cellId: "cell",
          invocationId: "call",
          runtimeId: "run",
          threadId: "t",
          status: "completed",
          operations: [],
        };
      if (request.command === "export")
        response.artifact = {
          ...artifact,
          path: "/var/lib/valet/browser/transfers/shot",
          transferId: "transfer",
        };
      return { exitCode: 0, stdout: JSON.stringify(response), stderr: "" };
    },
  };
  const ctx: PluginActionContext = {
    actionId: "browser.execute",
    service: "browser",
    userId: "u",
    orgId: "o",
    sessionId: "s",
    threadId: "t",
    invocationId: "call",
    owner: { type: "user", id: "u" },
    sandbox,
    credentials: {
      get: async () => null,
      request: async () => {
        throw new Error("unused");
      },
    },
    signal: new AbortController().signal,
    threadRead: async () => [],
    listThreads: async () => [],
    setModel: async () => {
      throw new Error("unused");
    },
    requestDecision: async (gate) => {
      decisions.push(gate.resumeKey ?? "");
      return {
        actionId: options.denied ? "deny" : "allow",
        resolvedBy: "u",
        resolvedAt: Date.now(),
      };
    },
    browserPolicy: {
      authorize: async () => {
        if (options.authorized === false)
          throw new Error("Browser access denied. Ask the owner for access.");
        return { policyVersion: "1" };
      },
      decide: async () => ({ decision: "ask", policyVersion: "1" }),
      approve: async () => ({ policyVersion: "1" }),
      audit: async () => {},
      persistArtifact: async (_identity, info, bytes) => {
        expect(bytes).toEqual(image);
        return { ...info, url: "/api/sessions/s/browser/evidence/shot" };
      },
    },
  };
  const action = browserPlugin.actions.find(
    (entry) => entry.id === "browser.execute",
  );
  if (!action) throw new Error("Missing execute action");
  return {
    requests,
    decisions,
    ctx,
    run: () =>
      action.execute(
        {
          code: 'await tab.playwright.getByRole("button").click()',
          title: "Submit form",
        },
        ctx,
      ),
  };
}

describe("browser action integration", () => {
  it("submits a stable invocation and resolves the exact paused operation", async () => {
    const f = fixture();
    await expect(f.run()).resolves.toMatchObject({
      success: true,
      data: { text: "done" },
    });
    expect(f.requests[0]).toMatchObject({
      ...identity,
      command: "submit",
      invocationId: "call",
    });
    expect(f.requests[1]).toMatchObject({
      command: "resolve",
      operationId: "op",
      hash: "hash",
      runtimeId: "run",
      decision: "allow",
    });
    expect(f.decisions).toEqual(["browser:call:op:hash"]);
  });
  it("passes denial without executing a fresh cell", async () => {
    const f = fixture({ denied: true });
    await f.run();
    expect(f.requests.filter((r) => r.command === "submit")).toHaveLength(1);
    expect(f.requests[1]).toMatchObject({
      command: "resolve",
      decision: "deny",
    });
  });
  it("exports image bytes, persists evidence, then acknowledges the transfer", async () => {
    const f = fixture({ image: true });
    const result = await f.run();
    expect(result.attachments).toEqual([
      { type: "image", data: image, mimeType: "image/png", name: "shot.png" },
    ]);
    expect(f.requests).toContainEqual(
      expect.objectContaining({ command: "ack", transferId: "transfer" }),
    );
  });
  it("fails closed before starting the sandbox when the actor lacks access", async () => {
    const f = fixture({ authorized: false });
    await expect(f.run()).rejects.toThrow("Browser access denied");
    expect(f.requests).toEqual([]);
  });
  it("requires the persisted invocation ID instead of inventing one", async () => {
    const f = fixture();
    delete f.ctx.invocationId;
    await expect(f.run()).rejects.toThrow("invocation");
    expect(f.requests).toEqual([]);
  });
  it("cancels the daemon when an awaited transport call is aborted", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.ctx.signal = controller.signal;
    const original = f.ctx.sandbox.exec;
    f.ctx.sandbox.exec = async (command, opts) => {
      const request: BrowserRequest = JSON.parse(opts?.stdin ?? "null");
      if (request.command === "events") {
        controller.abort();
        throw new Error("Transport aborted");
      }
      return original(command, opts);
    };
    await expect(f.run()).rejects.toThrow("Transport aborted");
    expect(f.requests).toContainEqual(
      expect.objectContaining({ command: "cancel", invocationId: "call" }),
    );
  });
  it("preserves a paused daemon continuation when the engine suspends a decision", async () => {
    const f = fixture();
    f.ctx.requestDecision = async () => {
      throw new Error("Decision suspension");
    };
    await expect(f.run()).rejects.toThrow("Decision suspension");
    expect(f.requests.some((request) => request.command === "cancel")).toBe(
      false,
    );
  });
  it("drains terminal event pages before returning the result", async () => {
    const f = fixture();
    const original = f.ctx.sandbox.exec;
    let pages = 0;
    f.ctx.sandbox.exec = async (command, opts) => {
      const reply = await original(command, opts);
      const request: BrowserRequest = JSON.parse(opts?.stdin ?? "null");
      if (request.command === "events" && ++pages === 1) {
        const response: BrowserResponse = JSON.parse(reply.stdout);
        response.events = [
          { type: "text", text: "last page", cursor: 100, timestamp: 1 },
        ];
        response.cursor = 100;
        reply.stdout = JSON.stringify(response);
      }
      return reply;
    };
    await expect(f.run()).resolves.toMatchObject({
      success: true,
      data: { text: "done\nlast page" },
    });
    expect(pages).toBe(2);
  });
});
