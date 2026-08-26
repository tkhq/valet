/**
 * `GET /api/ready` — the readiness half of the health/readiness split
 * (boot-ordering fix, sha-a6eadbe rollout RCA). `/api/health` answers as
 * soon as the port binds; `/api/ready` stays 503 until `main.ts`'s
 * background boot chain flips its flag. These tests drive the flag through
 * `bootTestApi`'s `isReady` passthrough.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { ReadyResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

describe("GET /api/ready", () => {
  it("reports 503 before the boot chain completes and 200 after", async () => {
    let ready = false;
    api = await bootTestApi({ isReady: () => ready });

    const before = await fetch(`${api.baseUrl}/api/ready`);
    expect(before.status).toBe(503);
    expect(((await before.json()) as ReadyResponse).ready).toBe(false);

    // Health must answer 200 the whole time — liveness never waits on boot.
    const health = await fetch(`${api.baseUrl}/api/health`);
    expect(health.status).toBe(200);

    ready = true;
    const after = await fetch(`${api.baseUrl}/api/ready`);
    expect(after.status).toBe(200);
    expect(((await after.json()) as ReadyResponse).ready).toBe(true);
  });

  it("defaults to ready when no isReady callback is wired (test harnesses, embedded callers)", async () => {
    api = await bootTestApi({});

    const res = await fetch(`${api.baseUrl}/api/ready`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as ReadyResponse).ready).toBe(true);
  });
});
