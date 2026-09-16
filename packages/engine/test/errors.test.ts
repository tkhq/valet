import { describe, expect, it } from "vitest";
import { SandboxPreparationError } from "../src/errors.js";

describe("SandboxPreparationError", () => {
  it("reports an unknown rejection shape as JSON", () => {
    const cause = { failure: "mount denied", retryable: false, attempts: 3 };
    expect(new SandboxPreparationError(cause).message).toBe(
      'sandbox preparation failed: {"failure":"mount denied","retryable":false,"attempts":3}',
    );
  });

  it("filters payloads and secrets in unknown rejection shapes", () => {
    const cause = {
      failure: "mount denied", metadata: { phase: "mount", access_token: "secret" },
      headers: { Authorization: "secret" }, command: "secret", config: { value: "secret" },
      body: "secret", stderr: "secret", stdin: "secret", password: "secret", apiKey: "secret",
      key: "secret", clientKeyData: "secret", pass: "secret",
      "client-key-data": "secret", client_key_data: "secret", "client.key.data": "secret",
      cmd: "secret", argv: ["secret"], output: "secret",
      variables: [{ name: "API_TOKEN", value: "secret" }],
    };
    expect(new SandboxPreparationError(cause).message).toBe(
      'sandbox preparation failed: {"failure":"mount denied","metadata":"[object]","variables":"[array]"}',
    );
  });

  it("describes nested values and bigint without losing sibling diagnostics", () => {
    const cause: Record<string, unknown> = { failure: "mount denied", count: 1n };
    cause.self = cause;
    expect(new SandboxPreparationError(cause).message).toContain(
      '{"failure":"mount denied","count":"1","self":"[object]"}',
    );
  });

  it("never invokes fallback getters or serializers", () => {
    let calls = 0;
    const cause = {
      failure: "mount denied",
      get extra(): string { calls++; throw new Error("getter must not run"); },
      toJSON() { calls++; throw new Error("serializer must not run"); },
      toString() { calls++; throw new Error("conversion must not run"); },
    };
    expect(new SandboxPreparationError(cause).message).toBe(
      'sandbox preparation failed: {"failure":"mount denied"}',
    );
    expect(calls).toBe(0);
  });

  it("bounds unknown fields before rendering the fallback", () => {
    const error = new SandboxPreparationError({ failure: "x".repeat(100_000) });
    expect(error.message.length).toBeLessThanOrEqual("sandbox preparation failed: ".length + 2048);
    expect(error.message).toContain("[truncated]");
  });

  it("keeps an error code when the message is truncated", () => {
    const error = new SandboxPreparationError({ message: "x".repeat(3000), code: "EACCES" });
    expect(error.message).toContain("EACCES");
    expect(error.message.length).toBeLessThanOrEqual("sandbox preparation failed: ".length + 2048);
  });

  it("survives a revoked proxy", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(new SandboxPreparationError(proxy).message).toContain("unserializable cause");
  });

  it("limits the number of copied fields", () => {
    const cause = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`f${index}`, index]));
    const error = new SandboxPreparationError(cause);
    expect(error.message).toContain('"f63":63');
    expect(error.message).not.toContain('"f64":64');
    expect(error.message).toContain("[truncated]");
  });

  it("does not enumerate nested payloads", () => {
    const nested = new Proxy({}, { ownKeys() { throw new Error("must not enumerate"); } });
    expect(new SandboxPreparationError({ failure: nested }).message).toBe(
      'sandbox preparation failed: {"failure":"[object]"}',
    );
  });

  it("retains diagnostics when a proxy rejects one property descriptor", () => {
    const cause = new Proxy({ failure: "mount denied", inaccessible: "secret" }, {
      getOwnPropertyDescriptor(target, key) {
        if (key === "inaccessible") throw new Error("descriptor failed");
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(new SandboxPreparationError(cause).message).toContain('"failure":"mount denied"');
  });

  it.each([
    { cause: new Error("clone failed"), detail: "clone failed" },
    { cause: { message: "clone failed", code: "EACCES" }, detail: "(EACCES) clone failed" },
    { cause: { message: "clone failed" }, detail: "clone failed" },
    { cause: { code: 403 }, detail: "403" },
    { cause: { reason: "clone denied", status: 403 }, detail: '{"reason":"clone denied","status":403}' },
    { cause: "clone failed", detail: "clone failed" },
    { cause: null, detail: "null" },
    { cause: undefined, detail: "undefined" },
    { cause: 42, detail: "42" },
  ])("reports $detail and preserves the cause", ({ cause, detail }) => {
    const error = new SandboxPreparationError(cause);
    expect(error.message).toBe(`sandbox preparation failed: ${detail}`);
    expect(error.cause).toBe(cause);
    expect(error.code).toBe("sandbox_preparation_failed");
    expect(error.name).toBe("SandboxPreparationError");
  });

  it("reads non-enumerable message and code fields", () => {
    const cause = Object.defineProperties({}, {
      message: { value: "permission denied" },
      code: { value: "EACCES" },
    });
    expect(new SandboxPreparationError(cause).message).toContain("(EACCES) permission denied");
  });

  it("does not replace the prep failure when serialization fails", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const cause of [circular, { count: 1n }, { toJSON() { throw new Error("serializer failed"); } }, Object.create(null)]) {
      expect(new SandboxPreparationError(cause).cause).toBe(cause);
    }
  });

  it("falls back to JSON when a message getter throws", () => {
    const cause = Object.defineProperty({ reason: "clone denied" }, "message", {
      get() { throw new Error("getter failed"); },
    });
    expect(new SandboxPreparationError(cause).message).toContain('{"reason":"clone denied"}');
  });

  it("handles objects that reject both JSON and string conversion", () => {
    const cause = { toJSON() { throw new Error("serializer failed"); }, toString() { throw new Error("conversion failed"); } };
    const error = new SandboxPreparationError(cause);
    expect(error.message).toBe("sandbox preparation failed: unserializable cause");
    expect(error.cause).toBe(cause);
  });

  it("omits request credentials, commands, and nested payloads", () => {
    const cause = {
      reason: "clone denied", status: 403,
      headers: { Authorization: "Bearer secret-header" },
      command: "git clone https://user:secret-token@example.com/repo",
      config: { password: "secret-password" },
      body: "secret-body", stderr: "secret-stderr",
    };
    const error = new SandboxPreparationError(cause);
    expect(error.message).toBe('sandbox preparation failed: {"reason":"clone denied","status":403}');
    expect(error.cause).toBe(cause);
  });

  it("does not serialize nested diagnostic fields or call custom serializers", () => {
    const cause = {
      reason: { Authorization: "secret" }, status: 403,
      toJSON() { throw new Error("must not run"); },
    };
    expect(new SandboxPreparationError(cause).message).toBe('sandbox preparation failed: {"status":403}');
  });

  it.each([
    "x".repeat(100_000), new Error("x".repeat(100_000)),
    { message: "x".repeat(100_000), code: "EACCES" },
    { reason: "x".repeat(100_000), body: "y".repeat(1_000_000) },
  ])("bounds formatted details and marks truncation", (cause) => {
    const error = new SandboxPreparationError(cause);
    expect(error.message.length).toBeLessThanOrEqual("sandbox preparation failed: ".length + 2048);
    expect(error.message).toContain("[truncated]");
    expect(error.cause).toBe(cause);
  });

  it("retains diagnostic fields beside an enumerable throwing getter", () => {
    const cause = { get message(): string { throw new Error("getter failed"); }, reason: "clone denied", status: 403 };
    expect(new SandboxPreparationError(cause).message).toBe('sandbox preparation failed: {"reason":"clone denied","status":403}');
  });

  it("preserves a proxy cause when property reads throw", () => {
    const cause = new Proxy({}, { get() { throw new Error("read failed"); } });
    const error = new SandboxPreparationError(cause);
    expect(error.message).toBe("sandbox preparation failed: unserializable cause");
    expect(error.cause).toBe(cause);
  });
});
