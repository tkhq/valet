import { afterEach, describe, expect, it } from "vitest";
import type { GetChangelogResponse } from "../wire/types.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";

let api: TestApi | undefined;
afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

describe("GET /api/changelog", () => {
  it("serves the bundled release artifact through the authenticated app", async () => {
    api = await bootTestApi();
    const response = await fetch(`${api.baseUrl}/api/changelog`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as GetChangelogResponse;
    expect(body.manifest.schema).toBe("valet-changelog/v2");
    expect(body.manifest.checkpoints[0]?.entries.length).toBeGreaterThan(0);
    expect(body.artifact.checkpointId).toBe(body.manifest.checkpoints[0]?.id);
  });
});
