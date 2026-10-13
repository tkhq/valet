import { describe, expect, it } from "vitest";
import { signState, verifyState, type StatePurpose } from "./oauth-state.js";

const KEY = Buffer.from("test-key-material-32-bytes-long");
const PURPOSES: StatePurpose[] = ["github-app-setup", "github-connect", "integration-connect"];
const acceptAll = (payload: unknown) => payload;

describe("signed state purposes", () => {
  it.each(PURPOSES)("verifies a %s state for its own purpose", (purpose) => {
    expect(verifyState(purpose, signState(purpose, { a: 1 }, KEY), KEY, acceptAll)).toEqual({ a: 1 });
  });

  it.each(PURPOSES.flatMap((signed) => PURPOSES.filter((other) => other !== signed).map((other) => [signed, other])))(
    "refuses a %s state for %s, even when the guard accepts the payload",
    (signed, other) => {
      expect(verifyState(other, signState(signed, { a: 1 }, KEY), KEY, acceptAll)).toBeNull();
    },
  );

  it("refuses a state signed with another key", () => {
    const state = signState("github-connect", { a: 1 }, Buffer.from("another-key"));
    expect(verifyState("github-connect", state, KEY, acceptAll)).toBeNull();
  });
});
