import { describe, expect, it } from "vitest";
import { DEFAULT_TURNKEY_API_BASE_URL, loadTurnkeyConfig } from "./config.js";

const full = {
  VALET_TURNKEY_ORGANIZATION_ID: "org-1",
  VALET_TURNKEY_API_PUBLIC_KEY: "02aa",
  VALET_TURNKEY_API_PRIVATE_KEY: "bb",
};

describe("loadTurnkeyConfig", () => {
  it("returns null when nothing is set", () => {
    expect(loadTurnkeyConfig({})).toBeNull();
    expect(loadTurnkeyConfig({ VALET_TURNKEY_API_BASE_URL: "https://x" })).toBeNull();
  });

  it("reads the full set and defaults the base url", () => {
    expect(loadTurnkeyConfig(full)).toEqual({
      organizationId: "org-1",
      apiPublicKey: "02aa",
      apiPrivateKey: "bb",
      apiBaseUrl: DEFAULT_TURNKEY_API_BASE_URL,
    });
    expect(loadTurnkeyConfig({ ...full, VALET_TURNKEY_API_BASE_URL: " https://api.dev " })?.apiBaseUrl).toBe(
      "https://api.dev",
    );
  });

  it("names the missing variables of a partial set", () => {
    expect(() => loadTurnkeyConfig({ VALET_TURNKEY_ORGANIZATION_ID: "org-1" })).toThrow(
      /VALET_TURNKEY_API_PUBLIC_KEY, VALET_TURNKEY_API_PRIVATE_KEY/,
    );
  });
});
