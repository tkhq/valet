/**
 * `GET /api/health` — public, unauthenticated. Single-binary CLI plan T6:
 * the response must carry a non-empty `version` (so `valet status` can
 * report client/server versions + skew) and a `sandboxBackend` (so
 * `valet status` can report the running backend). Both are append-only
 * additions to the pre-existing `{ ok, service, ts }` shape.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "./integration/_setup.js";
import { VALET_VERSION } from "./version.js";
import type { HealthResponse } from "./wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

describe("GET /api/health", () => {
  it("includes a non-empty version and a sandboxBackend", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/health`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as HealthResponse;
    expect(body.ok).toBe(true);
    expect(body.service).toBe("valet-api");
    expect(typeof body.ts).toBe("number");

    // The two T6 additions.
    expect(body.version).toBe(VALET_VERSION);
    expect(body.version).not.toBe("");
    // Resolved from VALET_SANDBOX_BACKEND (unset → "docker"). Assert it is a
    // real, recognized backend rather than pinning "docker" — the api suite
    // may run docker/local test files that leave the env var set.
    expect(body.sandboxBackend).toBeTruthy();
    expect(["docker", "local", "kubernetes"]).toContain(body.sandboxBackend);
  });
});
