import { describe, expect, it } from "vitest";
import { plaintextFor } from "./index";

describe("plaintextFor", () => {
  it("seals the bare value for an ordinary secret", () => {
    expect(plaintextFor({ kind: "k" }, "sk-123")).toBe("sk-123");
  });

  it("seals the value with the client, owner and rule for a use-only secret", () => {
    const rules = { hosts: ["api.example.com"], methods: [], pathPrefixes: [], header: "authorization", format: "Bearer {secret}" };
    const sealed = plaintextFor({ kind: "k", use: { client: "02ab", owner: "valet:o:user:u", rules } }, "sk-123");
    expect(JSON.parse(sealed)).toEqual({ v: 1, value: "sk-123", client: "02ab", owner: "valet:o:user:u", rules });
  });
});
