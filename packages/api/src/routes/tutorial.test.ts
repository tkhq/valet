/**
 * `/api/tutorial`: version gating for a new, a finished, and a bumped user;
 * resume; the org admin reset; and input checks.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { TutorialStateResponse } from "../wire/types.js";
import { tutorialDue } from "../services/tutorial.js";

const ADMIN = { "Content-Type": "application/json" };
const MEMBER = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };

let api: TestApi | undefined;
afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

async function state(headers: Record<string, string> = ADMIN): Promise<TutorialStateResponse> {
  const res = await fetch(`${api!.baseUrl}/api/tutorial`, { headers });
  expect(res.status).toBe(200);
  return (await res.json()) as TutorialStateResponse;
}

async function put(body: unknown, headers: Record<string, string> = ADMIN): Promise<Response> {
  return fetch(`${api!.baseUrl}/api/tutorial`, { method: "PUT", headers, body: JSON.stringify(body) });
}

/** A progress save for the tour shown at `seen`'s versions. */
async function step(id: string, seen: { version: number; orgVersion: number }, headers = ADMIN) {
  const res = await put({ step: id, version: seen.version, orgVersion: seen.orgVersion }, headers);
  expect(res.status).toBe(200);
  return (await res.json()) as TutorialStateResponse;
}

async function finish(seen: TutorialStateResponse, outcome: "completed" | "skipped", headers = ADMIN) {
  const res = await put({ outcome, version: seen.version, orgVersion: seen.orgVersion }, headers);
  expect(res.status).toBe(200);
  return (await res.json()) as TutorialStateResponse;
}

describe("tutorialDue", () => {
  it("is due with no outcome or a lower stored version", () => {
    const base = { version: 2, orgVersion: 1, seenVersion: 2, seenOrgVersion: 1 };
    expect(tutorialDue({ ...base, outcome: null })).toBe(true);
    expect(tutorialDue({ ...base, outcome: "completed" })).toBe(false);
    expect(tutorialDue({ ...base, seenVersion: 1, outcome: "skipped" })).toBe(true);
    expect(tutorialDue({ ...base, seenOrgVersion: 0, outcome: "completed" })).toBe(true);
  });
});

describe("/api/tutorial", () => {
  it("shows the tour to a new user at the default version", async () => {
    api = await bootTestApi();
    expect(await state()).toEqual({
      version: 1, orgVersion: 0, seenVersion: 0, seenOrgVersion: 0, outcome: null, step: null, due: true,
    });
  });

  it("does not show it again after it is completed or skipped", async () => {
    api = await bootTestApi();
    const done = await finish(await state(), "completed");
    expect(done).toMatchObject({ seenVersion: 1, outcome: "completed", due: false });
    expect((await state()).due).toBe(false);
    // Another user is not affected.
    const member = await state(MEMBER);
    expect(member.due).toBe(true);
    expect((await finish(member, "skipped", MEMBER)).due).toBe(false);
  });

  it("shows it again when the instance version rises, with no data wipe", async () => {
    api = await bootTestApi();
    await finish(await state(), "completed");
    api.providers.tutorialVersion = 2;
    const bumped = await state();
    expect(bumped).toMatchObject({ version: 2, seenVersion: 1, outcome: "completed", due: true, step: null });
    expect((await finish(bumped, "skipped")).due).toBe(false);
  });

  it("resumes at the saved step and clears it on finish", async () => {
    api = await bootTestApi();
    await step("workflows", await state());
    expect(await state()).toMatchObject({ step: "workflows", due: true, outcome: null });
    const done = await finish(await state(), "skipped");
    expect(done).toMatchObject({ step: null, due: false });
  });

  it("ignores a progress write that arrives after the tour is finished", async () => {
    api = await bootTestApi();
    const v1 = await state();
    await finish(v1, "completed");
    await step("home", v1);
    expect(await state()).toMatchObject({ outcome: "completed", step: null, due: false });
    // After a version bump, a late step from the version 1 tour is stale.
    api.providers.tutorialVersion = 2;
    await step("workflows", v1);
    expect(await state()).toMatchObject({ outcome: "completed", step: null, due: true });
    // A step from the version 2 tour saves.
    await step("spaces", await state());
    expect(await state()).toMatchObject({ outcome: null, step: "spaces", due: true });
  });

  it("does not resume a step saved just before an org reset", async () => {
    api = await bootTestApi();
    await step("workflows", await state());
    expect((await fetch(`${api.baseUrl}/api/tutorial/reset`, { method: "POST", headers: ADMIN })).status).toBe(200);
    expect(await state()).toMatchObject({ orgVersion: 1, outcome: null, step: null, due: true });
  });

  it("ignores a step from before an org reset", async () => {
    api = await bootTestApi();
    const before = await state();
    await finish(before, "completed");
    expect((await fetch(`${api.baseUrl}/api/tutorial/reset`, { method: "POST", headers: ADMIN })).status).toBe(200);
    await step("presence", before);
    expect(await state()).toMatchObject({ orgVersion: 1, step: null, due: true });
  });

  it("an admin reset shows the tour to every member again", async () => {
    api = await bootTestApi();
    await finish(await state(), "completed");
    await finish(await state(MEMBER), "completed", MEMBER);

    const denied = await fetch(`${api.baseUrl}/api/tutorial/reset`, { method: "POST", headers: MEMBER });
    expect(denied.status).toBe(403);
    expect((await state(MEMBER)).due).toBe(false);

    const res = await fetch(`${api.baseUrl}/api/tutorial/reset`, { method: "POST", headers: ADMIN });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgVersion: 1 });
    expect(await state(MEMBER)).toMatchObject({ orgVersion: 1, seenOrgVersion: 0, due: true });
    expect((await state()).due).toBe(true);
  });

  it("caps versions above the current ones and never lowers a stored one", async () => {
    api = await bootTestApi();
    expect((await put({ outcome: "completed", version: 99, orgVersion: 99 })).status).toBe(200);
    expect(await state()).toMatchObject({ seenVersion: 1, seenOrgVersion: 0, due: false });
    // A stale tab that saw version 0 must not re-show the tour.
    expect((await put({ outcome: "skipped", version: 0, orgVersion: 0 })).status).toBe(200);
    expect(await state()).toMatchObject({ seenVersion: 1, due: false });
  });

  it("rejects bad input with the fix", async () => {
    api = await bootTestApi();
    for (const body of [{}, { outcome: "done" }, { step: "", version: 1, orgVersion: 0 }, { step: "x".repeat(65), version: 1, orgVersion: 0 }, { step: "home" }, { outcome: "completed", version: -1 }, []]) {
      const res = await put(body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/\./);
    }
  });
});
