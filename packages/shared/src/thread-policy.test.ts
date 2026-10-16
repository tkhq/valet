import { describe, expect, it } from "vitest";
import { DEFAULT_THREAD_POLICY, readThreadPolicy, validateThreadPolicy } from "./thread-policy.js";

describe("thread-policy", () => {
  it("validates each known mode", () => {
    expect(validateThreadPolicy({ mode: "new" })).toBeNull();
    expect(validateThreadPolicy({ mode: "subject" })).toBeNull();
    expect(validateThreadPolicy({ mode: "own" })).toBeNull();
    expect(validateThreadPolicy({ mode: "existing", sessionId: "s1", threadId: "t1" })).toBeNull();
  });

  it("rejects an unknown mode", () => {
    expect(validateThreadPolicy({ mode: "bogus" })).toBe(
      "Thread policy mode must be new, subject, own, or existing.",
    );
  });

  it("rejects existing mode missing sessionId or threadId", () => {
    expect(validateThreadPolicy({ mode: "existing" })).toBe(
      "An existing thread needs sessionId and threadId.",
    );
    expect(validateThreadPolicy({ mode: "existing", sessionId: "s1" })).toBe(
      "An existing thread needs sessionId and threadId.",
    );
    expect(validateThreadPolicy({ mode: "existing", threadId: "t1" })).toBe(
      "An existing thread needs sessionId and threadId.",
    );
  });

  it("rejects a non-object value", () => {
    expect(validateThreadPolicy(null)).toBe("Thread policy must be an object with a mode.");
    expect(validateThreadPolicy("new")).toBe("Thread policy must be an object with a mode.");
    expect(validateThreadPolicy([])).toBe("Thread policy must be an object with a mode.");
  });

  it("defaults readThreadPolicy(undefined) to own", () => {
    expect(readThreadPolicy(undefined)).toEqual(DEFAULT_THREAD_POLICY);
    expect(DEFAULT_THREAD_POLICY).toEqual({ mode: "own" });
  });

  it("passes a valid policy through readThreadPolicy", () => {
    expect(readThreadPolicy({ mode: "existing", sessionId: "s1", threadId: "t1" })).toEqual({
      mode: "existing",
      sessionId: "s1",
      threadId: "t1",
    });
  });
});
