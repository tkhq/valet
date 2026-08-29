/**
 * Diff-scoped re-scan at start (re-scan / iterate, valet-security design
 * §Re-scan / iterate). Proves the `POST /security/start` route computes the
 * GitHub compare between the parent's pinned SHA (base) and the new HEAD, and
 * that:
 *   - a successful compare scopes the sweep cells to the changed dirs and
 *     records base_ref + changed_paths on the engagement;
 *   - a compare failure falls back to a FULL scan without failing the start.
 *
 * No ANTHROPIC_API_KEY and no model turn: the parent engagement is started at
 * the service level (SHA pinning is not under test), and the re-scan's start is
 * driven through the internal-token route with the acting-session header — the
 * same seam the runner's sec_start tool uses. The GitHub compare is mocked with
 * the shared fixture via GITHUB_API_URL.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { KNOWN_PERSONAS, parsePlan } from "@valet/plugin-security";
import { bootTestApi, type TestApi } from "./_setup.js";
import { internalToken } from "../lib/internal-auth.js";
import { createSecurityEngagementService } from "../services/security-engagements.js";
import { startGithubFixture, type GithubFixture, type GithubFixtureResponse } from "../test-helpers/github-fixture.js";
import type { CreateSessionResponse, GetSessionSecurityResponse } from "../wire/types.js";

const SHA_OLD = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";
const SHA_NEW = "fedcba9876543210fedcba9876543210fedcba98";
const REPO = { fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", ref: SHA_OLD };

let api: TestApi | undefined;
let fixture: GithubFixture;
let compareHandler: (owner: string, repo: string, range: string) => GithubFixtureResponse;
const prevGithubApiUrl = process.env.GITHUB_API_URL;

beforeEach(() => {
  compareHandler = () => ({ body: { files: [] } });
  fixture = startGithubFixture({ getCompare: (o, r, range) => compareHandler(o, r, range) });
  process.env.GITHUB_API_URL = fixture.url;
});

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  await fixture.close();
  if (prevGithubApiUrl === undefined) delete process.env.GITHUB_API_URL;
  else process.env.GITHUB_API_URL = prevGithubApiUrl;
});

/** Create a re-scan session of `parentId`, start it via the internal-token
 * route with `resolvedSha`, and return the resulting /security read. */
async function startRescan(
  baseUrl: string,
  parentId: string,
  resolvedSha: string,
): Promise<GetSessionSecurityResponse> {
  const rescanRes = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace: `/tmp/valet-sec-rescan-${randomUUID()}`, kind: "security", rescanOf: parentId }),
  });
  expect(rescanRes.status).toBe(201);
  const rescan = (await rescanRes.json()) as CreateSessionResponse;

  const startRes = await fetch(`${baseUrl}/api/sessions/${rescan.id}/security/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-valet-internal": internalToken(),
      "x-valet-session-id": rescan.id,
    },
    body: JSON.stringify({ resolvedSha }),
  });
  expect(startRes.status).toBe(200);

  return (await (await fetch(`${baseUrl}/api/sessions/${rescan.id}/security`)).json()) as GetSessionSecurityResponse;
}

/** Create a parent security session and start its engagement at SHA_OLD. */
async function startedParent(api: TestApi): Promise<string> {
  const res = await fetch(`${api.baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace: `/tmp/valet-sec-parent-${randomUUID()}`, kind: "security", repo: REPO }),
  });
  expect(res.status).toBe(201);
  const parent = (await res.json()) as CreateSessionResponse;
  const service = createSecurityEngagementService({ db: api.providers.db });
  const found = await service.getEngagementBySession(parent.id);
  await service.startEngagement(found!.engagement.id, { resolvedSha: SHA_OLD });
  return parent.id;
}

describe("api integration: diff-scoped re-scan at start", () => {
  it("scopes sweeps to the changed dirs and records base_ref + changed_paths", async () => {
    api = await bootTestApi();
    compareHandler = () => ({
      body: {
        status: "ahead",
        files: [
          { filename: "src/routes/sessions.ts", status: "modified" },
          { filename: "src/auth/login.ts", status: "added" },
        ],
      },
    });

    const parentId = await startedParent(api);
    const sec = await startRescan(api.baseUrl, parentId, SHA_NEW);

    // The compare ran with the parent SHA (base) → new HEAD.
    const compareCall = fixture.calls.find((c) => c.path.includes("/compare/"));
    expect(compareCall?.params.range).toBe(`${SHA_OLD}...${SHA_NEW}`);

    // The engagement records the diff context.
    expect(sec.engagement.baseRef).toBe(SHA_OLD);
    expect(sec.engagement.changedPaths).toEqual(["src/routes/sessions.ts", "src/auth/login.ts"]);

    // The sweeps carry the changed-dir globs; recon, the reconcile cell, and
    // verify stay repo-wide (re-scan v2 — reconcile re-checks EVERY carried
    // finding, not only the changed files).
    const plan = parsePlan(sec.engagement.plan, KNOWN_PERSONAS);
    const recon = plan.cells.find((c) => c.ordinal === 1);
    const reconcile = plan.cells.find((c) => c.persona === "reconcile");
    const verify = plan.cells.find((c) => c.review === true);
    const sweeps = plan.cells.filter(
      (c) => c.ordinal !== 1 && c.review !== true && c.persona !== "reconcile",
    );
    expect(recon?.paths).toBeUndefined();
    expect(reconcile).toBeDefined();
    expect(reconcile?.paths).toBeUndefined();
    expect(verify?.paths).toBeUndefined();
    expect(sweeps.length).toBeGreaterThan(0);
    for (const sweep of sweeps) {
      expect(sweep.paths).toEqual(["src/auth/**", "src/routes/**"]);
    }
  });

  it("falls back to a full scan when the compare fails, without erroring the start", async () => {
    api = await bootTestApi();
    compareHandler = () => ({ status: 404, body: { message: "Not Found" } });

    const parentId = await startedParent(api);
    const sec = await startRescan(api.baseUrl, parentId, SHA_NEW);

    // The compare was attempted, but its failure is swallowed.
    expect(fixture.calls.some((c) => c.path.includes("/compare/"))).toBe(true);
    // A full scan: no changed-path scoping, changed_paths null.
    expect(sec.engagement.changedPaths).toBeNull();
    expect(sec.engagement.status).toBe("running");
    const plan = parsePlan(sec.engagement.plan, KNOWN_PERSONAS);
    expect(plan.cells.every((c) => c.paths === undefined)).toBe(true);
  });
});
