import { describe, expect, it } from "vitest";
import { probeRegistry } from "./registry-health.js";

const env = { VALET_REGISTRY_HEALTH_URL: "http://registry:5001/health" };
const response = (capacityBytes: number, availableBytes: number) =>
  (async () => Response.json({ capacityBytes, availableBytes, usedBytes: capacityBytes - availableBytes })) as typeof fetch;

describe("registry capacity admission", () => {
  it("blocks the incident disk before it reaches 100%", async () => {
    const health = await probeRegistry(env, response(246e9, 0.1e9));
    expect(health).toMatchObject({ status: "full", capacityBytes: 246e9, availableBytes: 0.1e9, reserveBytes: 24.6e9 });
  });
  it("recovers when space becomes available", async () => {
    expect(await probeRegistry(env, response(246e9, 50e9))).toMatchObject({ status: "healthy" });
  });
  it("blocks at the reserve boundary", async () => {
    expect(await probeRegistry(env, response(100e9, 10e9))).toMatchObject({ status: "full" });
  });
  it("allows zero absolute reserve while retaining percentage protection", async () => {
    expect(await probeRegistry({ ...env, VALET_REGISTRY_MIN_FREE_GB: "0" }, response(20e9, 4e9)))
      .toMatchObject({ status: "healthy", reserveBytes: 2e9 });
  });
  it("reports missing probes as unconfigured, never zero bytes", async () => {
    expect(await probeRegistry({})).toMatchObject({ status: "unconfigured", capacityBytes: null });
  });
  it("reports unavailable and malformed probes as unknown", async () => {
    const fail = (async () => { throw new Error("connection failed"); }) as typeof fetch;
    expect(await probeRegistry(env, fail)).toMatchObject({ status: "unknown", capacityBytes: null });
    expect(await probeRegistry(env, response(100, 200))).toMatchObject({ status: "unknown" });
    expect(await probeRegistry(env, response(-1, 0))).toMatchObject({ status: "unknown" });
  });
  it("uses a configurable absolute reserve and safe defaults for invalid settings", async () => {
    expect(await probeRegistry({ ...env, VALET_REGISTRY_MIN_FREE_GB: "30" }, response(100e9, 25e9)))
      .toMatchObject({ status: "full", reserveBytes: 30e9 });
    expect(await probeRegistry({ ...env, VALET_REGISTRY_MIN_FREE_GB: "NaN" }, response(20e9, 4e9)))
      .toMatchObject({ status: "full", reserveBytes: 5e9 });
  });
});
