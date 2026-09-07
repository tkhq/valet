/**
 * The public artifact router is mounted before the auth ladder and the
 * team-key scope gate, and resolves its caller itself. A team `vlt_` key
 * there must not read as the creating admin: it may read a public artifact
 * as an anonymous caller, and nothing else (TKAI-396 done-when 5).
 */
import { describe, expect, it, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { CreateTeamApiKeyResponse, CreateTeamResponse, ShareArtifactResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

function extractSessionCookie(setCookieHeader: string | null): string {
  expect(setCookieHeader).toBeTruthy();
  const match = setCookieHeader?.match(/better-auth\.session_token=[^;]+/);
  expect(match).toBeTruthy();
  return match![0];
}

async function signUp(baseUrl: string, email: string, name: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password: "correct-horse-battery" }),
  });
  expect(res.status).toBe(200);
  return extractSessionCookie(res.headers.get("set-cookie"));
}

async function createTeam(baseUrl: string, cookie: string, name: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/teams`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as CreateTeamResponse).team.id;
}

async function mintTeamKey(baseUrl: string, cookie: string, teamId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/teams/${teamId}/api-keys`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "CI" }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as CreateTeamApiKeyResponse).key;
}

/** The admin writes a memory file and shares it; the read URL comes back. */
async function shareArtifact(baseUrl: string, cookie: string): Promise<{ id: string; readUrl: string }> {
  const wrote = await fetch(`${baseUrl}/api/memory`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ path: "reports/deploys.md", content: "# Deploys\n\nBody.\n" }),
  });
  expect(wrote.status).toBe(200);
  const shared = await fetch(`${baseUrl}/api/artifacts/share`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ path: "reports/deploys.md" }),
  });
  expect(shared.status).toBe(200);
  const body = (await shared.json()) as ShareArtifactResponse;
  const token = new URL(body.url).pathname.replace(/^\/a\//, "");
  return { id: body.id, readUrl: `${baseUrl}/api/artifacts/${token}` };
}

async function widenToPublic(baseUrl: string, cookie: string, artifactId: string): Promise<void> {
  const flipped = await fetch(`${baseUrl}/api/org/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ allowPublicArtifacts: true }),
  });
  expect(flipped.status).toBe(200);
  const widened = await fetch(`${baseUrl}/api/artifacts/${artifactId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ visibility: "public" }),
  });
  expect(widened.status).toBe(200);
}

interface Fixture {
  baseUrl: string;
  cookie: string;
  teamKey: string;
  artifactId: string;
  readUrl: string;
}

async function bootFixture(): Promise<Fixture> {
  api = await bootTestApi({ auth: true });
  const cookie = await signUp(api.baseUrl, "admin@nowhere.test", "First Admin");
  const teamId = await createTeam(api.baseUrl, cookie, "Platform");
  const teamKey = await mintTeamKey(api.baseUrl, cookie, teamId);
  const { id, readUrl } = await shareArtifact(api.baseUrl, cookie);
  return { baseUrl: api.baseUrl, cookie, teamKey, artifactId: id, readUrl };
}

describe("team API key on the public artifact router", () => {
  it("cannot read an org-visibility artifact as the creating admin", async () => {
    const f = await bootFixture();
    const asAdmin = await fetch(f.readUrl, { headers: { cookie: f.cookie } });
    expect(asAdmin.status).toBe(200);

    const asTeamKey = await fetch(f.readUrl, { headers: { "x-api-key": f.teamKey } });
    expect(asTeamKey.status).toBe(403);
    expect(((await asTeamKey.json()) as { error: string }).error).toContain("public");
  });

  it("reads a public artifact as an anonymous caller: no sharer attribution", async () => {
    const f = await bootFixture();
    await widenToPublic(f.baseUrl, f.cookie, f.artifactId);

    const asTeamKey = await fetch(f.readUrl, { headers: { "x-api-key": f.teamKey } });
    expect(asTeamKey.status).toBe(200);
    const body = (await asTeamKey.json()) as { sharedBy?: string; canComment: boolean };
    expect(body.sharedBy).toBeUndefined();
    expect(body.canComment).toBe(false);
  });

  it("is refused on every comment route, public artifact or not", async () => {
    const f = await bootFixture();
    await widenToPublic(f.baseUrl, f.cookie, f.artifactId);
    const headers = { "content-type": "application/json", "x-api-key": f.teamKey };

    const listed = await fetch(`${f.readUrl}/comments`, { headers });
    expect(listed.status).toBe(403);
    const posted = await fetch(`${f.readUrl}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "from CI" }),
    });
    expect(posted.status).toBe(403);
  });
});
