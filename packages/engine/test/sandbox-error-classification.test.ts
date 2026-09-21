import { describe, expect, it } from "vitest";
import { isSandboxTransportError, PolicySandbox, SandboxAttachment, SandboxConnectionError, VirtualSandbox } from "../src/index.js";

describe("sandbox transport classification", () => {
  it.each([
    new Error("job kickoff failed", { cause: new Error("application stderr quotes socket hang up") }),
    "application stderr quotes Connection refused",
    { message: "job kickoff failed", error: "application stderr quotes socket hang up" },
  ])("does not degrade ordinary application failures from nested or untyped text", async (failure) => {
    const raw = new VirtualSandbox("application-failure-test");
    raw.exec = async () => { throw failure; };
    const attachment = SandboxAttachment.forSandbox(raw);
    try {
      const result = await new PolicySandbox(attachment).exec("test").catch((error: unknown) => error);
      expect(result).toBe(failure);
      expect(attachment.state).toBe("ready");
    } finally {
      await attachment.destroy();
    }
  });

  it.each([
    "socket hang up",
    new Error("bounded display", { cause: "x".repeat(3000) + " socket hang up" }),
    { error: "x".repeat(3000) + " socket hang up" },
  ])("recognizes raw string rejections and string causes", (cause) => {
    expect(isSandboxTransportError(new SandboxConnectionError("bounded display", cause))).toBe(true);
  });

  it("finds a connection failure behind wrapper and WebSocket event causes", () => {
    const raw = new Error("x".repeat(3000) + " socket hang up");
    expect(isSandboxTransportError(new SandboxConnectionError("bounded display", { error: raw }))).toBe(true);
  });

  it("uses the traversal budget for error objects, not absent fields", () => {
    let cause = new Error("socket hang up");
    for (let index = 0; index < 12; index++) cause = new Error("wrapper", { cause });
    expect(isSandboxTransportError(new SandboxConnectionError("bounded display", cause))).toBe(true);
  });

  it("tolerates cycles and throwing getters", () => {
    const cycle: Record<string, unknown> = { get message(): never { throw new Error("unreadable"); } };
    cycle.cause = cycle;
    expect(isSandboxTransportError(new SandboxConnectionError("bounded display", cycle))).toBe(false);
    cycle.error = new Error("Connection refused");
    expect(isSandboxTransportError(new SandboxConnectionError("bounded display", cycle))).toBe(true);
  });

  it("does not inspect arbitrary payload fields", () => {
    expect(isSandboxTransportError(new SandboxConnectionError("bounded display", {
      message: "Forbidden", request: { message: "socket hang up" },
    }))).toBe(false);
  });

  it("bounds traversal even when a getter creates a new cause on each read", () => {
    let reads = 0;
    function next(): object {
      return { get cause() { reads++; return next(); } };
    }
    expect(isSandboxTransportError(new SandboxConnectionError("bounded display", next()))).toBe(false);
    expect(reads).toBeLessThanOrEqual(16);
  });

  it("tolerates revoked proxy causes", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(isSandboxTransportError(proxy)).toBe(false);
    expect(isSandboxTransportError(new SandboxConnectionError("bounded display", proxy))).toBe(false);
  });
});
