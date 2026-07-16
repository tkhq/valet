/**
 * POST /api/sessions — Task 5 (sandbox auth gateway plan): create accepts
 * an optional `profile` ("headless" | "full"), persists it, and returns it.
 * Omitting `profile` defaults to "headless".
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { CreateSessionResponse, GetSessionResponse } from "../wire/types.js";

describe("POST /api/sessions: profile", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("defaults profile to 'headless' when omitted", async () => {
    api = await bootTestApi();
    const workspace = await mkdtemp(join(tmpdir(), "valet-session-create-"));

    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateSessionResponse;
    expect(body.profile).toBe("headless");

    const getRes = await fetch(`${api.baseUrl}/api/sessions/${body.id}`);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as GetSessionResponse;
    expect(getBody.profile).toBe("headless");
  });

  it("persists and returns profile: 'full' when requested", async () => {
    api = await bootTestApi();
    const workspace = await mkdtemp(join(tmpdir(), "valet-session-create-full-"));

    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, profile: "full" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateSessionResponse;
    expect(body.profile).toBe("full");

    const getRes = await fetch(`${api.baseUrl}/api/sessions/${body.id}`);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as GetSessionResponse;
    expect(getBody.profile).toBe("full");
  });

  it("rejects an invalid profile value", async () => {
    api = await bootTestApi();
    const workspace = await mkdtemp(join(tmpdir(), "valet-session-create-bad-"));

    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, profile: "bogus" }),
    });
    expect(res.status).toBe(400);
  });
});
