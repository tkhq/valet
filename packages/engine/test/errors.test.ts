import { describe, expect, it } from "vitest";
import { SandboxPreparationError } from "../src/errors.js";

describe("SandboxPreparationError", () => {
  it.each([
    { cause: new Error("clone failed"), detail: "clone failed" },
    { cause: { message: "clone failed", code: "EACCES" }, detail: "clone failed (EACCES)" },
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
    expect(new SandboxPreparationError(cause).message).toContain("permission denied (EACCES)");
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
});
