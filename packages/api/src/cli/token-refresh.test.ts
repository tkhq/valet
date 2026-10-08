import { afterEach, describe, expect, it, vi } from "vitest";
import type { ValetConfig } from "./config.js";
import { UnreachableError } from "./exit.js";
import { refreshSelectedProfile, type RefreshDeps } from "./token-refresh.js";

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

/** Deps whose file reads return `onDisk` (the config as another command may have saved it). */
function deps(overrides: Partial<RefreshDeps> & { onDisk: ValetConfig }): RefreshDeps {
  const { onDisk, ...rest } = overrides;
  return {
    refresh: vi.fn(async () => FRESH),
    save: vi.fn(),
    now: () => NOW,
    reload: () => onDisk,
    withLock: (fn) => fn(),
    ...rest,
  };
}

describe("refreshSelectedProfile", () => {
  it("refreshes a device sign-in that expires soon and saves the new pair", async () => {
    const refresh = vi.fn(async () => FRESH);
    const save = vi.fn();
    const next = await refreshSelectedProfile(config(NOW + HOUR), [], deps({ refresh, save, onDisk: config(NOW + HOUR) }));
    expect(refresh).toHaveBeenCalledWith("https://valet.example.com", "vltr_old");
    expect(next.profiles?.prod?.cli).toEqual({ accessToken: "vltc_new", refreshToken: "vltr_new", accessExpiresAt: FRESH.access_expires_at, refreshExpiresAt: FRESH.refresh_expires_at });
    expect(save).toHaveBeenCalledWith(next);
  });

  it("leaves a token with hours left, an API key profile, and a failed refresh alone", async () => {
    const save = vi.fn();
    const fresh = config(NOW + 20 * HOUR);
    expect(await refreshSelectedProfile(fresh, [], deps({ save, onDisk: fresh }))).toBe(fresh);
    const keyed = config(NOW);
    expect(await refreshSelectedProfile(keyed, ["--instance", "key"], deps({ save, onDisk: keyed }))).toBe(keyed);
    expect(await refreshSelectedProfile(keyed, [], deps({ refresh: vi.fn(async () => undefined), save, onDisk: keyed }))).toBe(keyed);
    expect(save).not.toHaveBeenCalled();
  });

  it("uses the pair another command saved while this one waited for the lock, without refreshing again", async () => {
    const refresh = vi.fn(async () => FRESH);
    const refreshedByOther = config(NOW + 24 * HOUR);
    const next = await refreshSelectedProfile(config(NOW + HOUR), [], deps({ refresh, onDisk: refreshedByOther }));
    expect(refresh).not.toHaveBeenCalled();
    expect(next).toBe(refreshedByOther);
  });

  it("retries once when the refresh request fails in transit", async () => {
    const refresh = vi.fn()
      .mockRejectedValueOnce(new UnreachableError("connection reset"))
      .mockResolvedValueOnce(FRESH);
    const next = await refreshSelectedProfile(config(NOW + HOUR), [], deps({ refresh, onDisk: config(NOW + HOUR) }));
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(next.profiles?.prod?.cli?.accessToken).toBe("vltc_new");
  });
});

describe("latestCredential", () => {
  it("returns the pair another command saved, refreshes a token near expiry, and leaves an API key alone", async () => {
    const { latestCredential } = await import("./token-refresh.js");
    const refreshedByOther: ValetConfig = { profiles: { prod: { url: "https://valet.example.com", cli: { accessToken: "vltc_other", refreshToken: "r", accessExpiresAt: NOW + 24 * HOUR, refreshExpiresAt: NOW + 720 * HOUR } } } };
    expect(await latestCredential("https://valet.example.com/", "vltc_old", deps({ onDisk: refreshedByOther }))).toBe("vltc_other");

    const refresh = vi.fn(async () => FRESH);
    expect(await latestCredential("https://valet.example.com", "vltc_old", deps({ refresh, onDisk: config(NOW + HOUR) }))).toBe("vltc_new");
    expect(refresh).toHaveBeenCalledTimes(1);

    expect(await latestCredential("https://valet.example.com", "vlt_apikey", deps({ onDisk: config(NOW) }))).toBe("vlt_apikey");
  });
});
