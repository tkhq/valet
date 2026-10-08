import { afterEach, describe, expect, it, vi } from "vitest";
import type { ValetConfig } from "./config.js";
import { refreshSelectedProfile } from "./token-refresh.js";

const HOUR = 60 * 60_000;
const NOW = 1_000_000_000;
const FRESH = { access_token: "vltc_new", refresh_token: "vltr_new", access_expires_at: NOW + 24 * HOUR, refresh_expires_at: NOW + 720 * HOUR };

function config(accessExpiresAt: number): ValetConfig {
  return {
    defaultProfile: "prod",
    profiles: {
      prod: { url: "https://valet.example.com/", cli: { accessToken: "vltc_old", refreshToken: "vltr_old", accessExpiresAt, refreshExpiresAt: NOW + HOUR } },
      key: { url: "https://other.example.com", apiKey: "vlt_x" },
    },
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("refreshSelectedProfile", () => {
  it("refreshes a device sign-in that expires soon and saves the new pair", async () => {
    const refresh = vi.fn(async () => FRESH);
    const save = vi.fn();
    const next = await refreshSelectedProfile(config(NOW + HOUR), [], { refresh, save, now: () => NOW });
    expect(refresh).toHaveBeenCalledWith("https://valet.example.com", "vltr_old");
    expect(next.profiles?.prod?.cli).toEqual({ accessToken: "vltc_new", refreshToken: "vltr_new", accessExpiresAt: FRESH.access_expires_at, refreshExpiresAt: FRESH.refresh_expires_at });
    expect(save).toHaveBeenCalledWith(next);
  });

  it("leaves a token with hours left, an API key profile, and a failed refresh alone", async () => {
    const save = vi.fn();
    const fresh = config(NOW + 20 * HOUR);
    expect(await refreshSelectedProfile(fresh, [], { refresh: vi.fn(async () => FRESH), save, now: () => NOW })).toBe(fresh);
    const keyed = config(NOW);
    expect(await refreshSelectedProfile(keyed, ["--instance", "key"], { refresh: vi.fn(async () => FRESH), save, now: () => NOW })).toBe(keyed);
    expect(await refreshSelectedProfile(keyed, [], { refresh: vi.fn(async () => undefined), save, now: () => NOW })).toBe(keyed);
    expect(save).not.toHaveBeenCalled();
  });
});
