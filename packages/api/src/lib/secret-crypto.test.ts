import { describe, expect, it } from "vitest";
import { DEV_ENCRYPTION_KEY, instanceEncryptionKey } from "./secret-crypto.js";

describe("instanceEncryptionKey", () => {
  it("uses the configured key", () => {
    expect(instanceEncryptionKey({ VALET_ENCRYPTION_KEY: "k" }, "https://valet.example.com")).toEqual({ key: "k" });
  });

  it("falls back to the dev key with a warning on a local instance", () => {
    const result = instanceEncryptionKey({}, undefined);
    expect(result).toMatchObject({ key: DEV_ENCRYPTION_KEY });
    expect("warning" in result && result.warning).toContain("VALET_ENCRYPTION_KEY");
  });

  it("refuses an instance with a public URL and no key, and names the fix", () => {
    const result = instanceEncryptionKey({ VALET_ENCRYPTION_KEY: "" }, "https://valet.example.com");
    expect(result).not.toHaveProperty("key");
    expect("error" in result && result.error).toMatch(/Set VALET_ENCRYPTION_KEY/);
  });
});
